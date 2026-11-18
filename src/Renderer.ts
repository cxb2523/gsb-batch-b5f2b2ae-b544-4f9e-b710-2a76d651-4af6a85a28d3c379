import { BaseRenderer, FullModel, UncompressedTextureLoader, DiffuseShader, CombinedAnimation, TextureUtils, FrameBuffer } from "webgl-framework";
import { mat4, vec3, vec4 } from "gl-matrix";
import { CameraMode } from "./CameraMode";
import { DiffuseScrollingShader } from "./shaders/DiffuseScrollingShader";
import { PlaneBodyLitShader } from "./shaders/PlaneBodyLitShader";
import { GlassShader } from "./shaders/GlassShader";
import { DiffuseScrollingFilteredShader } from "./shaders/DiffuseScrollingFilteredShader";
import { DiffuseScrollingFilteredTransitionShader } from "./shaders/DiffuseScrollingFilteredTransitionShader";
import { WindStripeShader } from "./shaders/WindStripeShader";
import { PlaneTapAnimator } from "./PlaneTapAnimator";
import { findLinePlaneIntersectionCoords } from "./MathUtils";
import { Formation, PlaneInstance, getFormationPlanes as getFormationPlanesFor } from "./Formations";
import { PlaneModel } from "./PlaneModel";
import { PlaneModelCache } from "./PlaneModelCache";
import { findTappedPlane } from "./TapHit";

const FOV_LANDSCAPE = 25.0;
const FOV_PORTRAIT = 35.0;

enum PlaneState {
    NORMAL,
    FLY_AWAY,
    FLY_IN
}

enum TerrainState {
    NORMAL,
    TRANSITION
}

interface PlanePreset {
    name: string;
    banking: number;
    props: number[][];
}

export class Renderer extends BaseRenderer {
    private lastTime = 0;

    private loaded = false;

    private fmQuad = new FullModel();
    private fmCloud = new FullModel();
    private fmPlaneBody: PlaneModel | undefined;
    private fmPlaneGlass: PlaneModel | undefined;
    private fmProp = new FullModel();

    private textureTerrain: WebGLTexture | undefined;
    private textureTargetTerrain: WebGLTexture | undefined;
    private texturePlane: WebGLTexture | undefined;
    private textureGlass: WebGLTexture | undefined;
    private textureCloud: WebGLTexture | undefined;
    private textureNoise: WebGLTexture | undefined;

    private mTriangleVerticesVignette: WebGLBuffer | undefined;

    private shaderDiffuse: DiffuseShader | undefined;
    private shaderDiffuseScrollingFiltered: DiffuseScrollingFilteredShader | undefined;
    private shaderDiffuseScrollingFilteredTransition: DiffuseScrollingFilteredTransitionShader | undefined;
    private shaderPlaneBody: PlaneBodyLitShader | undefined;
    private shaderGlass: GlassShader | undefined;
    private shaderWindStripe: WindStripeShader | undefined;

    private customCamera: mat4 | undefined;

    private Z_NEAR = 100.0;
    private Z_FAR = 2000.0;

    private timerCamera = 0;
    private CAMERA_PERIOD = 87000;

    private timerGroundMovement = 0;
    private GROUND_MOVEMENT_PERIOD = 15000 * 0.8;
    private timerGroundMovement2 = 0;
    private GROUND2_MOVEMENT_PERIOD = 74800 * 0.8;

    private timerPlaneWonder1 = 0;
    private PLANE_WONDER_PERIOD1 = 25000 * 0.993;
    private timerPlaneWonder2 = 0;
    private PLANE_WONDER_PERIOD2 = 6000 * 0.993;
    private timerPlaneProp = 0;
    private PLANE_PROP_PERIOD = 300 * 0.993;
    private timerGlass = 0;
    private GLASS_PERIOD = 1300;
    private timerGlass2 = 0;
    private GLASS2_PERIOD = 9000;
    private timerWind = 0;
    private WIND_PERIOD = 2500;
    private timerWind2 = 0;
    private WIND_PERIOD2 = 16000;
    private timerClouds = 0;
    private CLOUDS_PERIOD = 13000;
    private timerPlaneTransition = 0;
    private PLANE_TRANSITION_PERIOD = 1800;
    private timerTerrainTransition = 0;
    private TERRAIN_TRANSITION_PERIOD = 1500;

    private cameraMode = CameraMode.Rotating;

    protected matViewInverted = mat4.create();
    protected matViewInvertedTransposed = mat4.create();
    protected matTemp = mat4.create();
    protected cameraPosition = vec3.create();
    protected cameraRotation = vec3.create();

    protected tmpPosition1: [number, number, number] = [0, 0, 0];
    protected tmpPosition2: [number, number, number] = [0, 0, 0];
    protected tmpPosition3: [number, number, number] = [0, 0, 0];

    private planeTapAnimator = new PlaneTapAnimator();

    /**
     * Models of plane presets keyed by preset index. The preset in use keeps
     * its models resident; models of the preset which was replaced are
     * disposed so their WebGL buffers are freed.
     */
    private planeModelCache = new PlaneModelCache();

    /** Distance from the tap ray to a plane center that still counts as a hit. */
    private readonly TAP_HIT_RADIUS = 35;

    private matTapViewInverted = mat4.create();
    private matTapViewProjection = mat4.create();
    private matTapViewProjectionInverted = mat4.create();
    private vecTapCamera = vec3.create();
    private vecTapFar = vec3.create();
    private vecTapGround = vec3.create();

    public config = {
        planeHeight: 100,
        planeBanking: 0.25,
        planeWonderXY: 4,
        planeWonderZ: 6,

        propOffsetX: 33,
        propOffsetY: 12,
        propOffsetZ: 4,

        currentPlane: 0,
        currentPalette: 2,
        currentTerrain: 0,
        formation: Formation.Triangle
    };

    /**
     * Switches the active formation.
     *
     * Tap animations are keyed by plane identity: planes which remain part of
     * the new formation keep playing their animation, while animations of
     * planes which are no longer drawn end immediately instead of being shown
     * on whichever plane now occupies their draw index.
     */
    setFormation(formation: Formation): void {
        if (formation === this.config.formation) {
            return;
        }

        this.config.formation = formation;

        const planes = this.getFormationPlanes(formation);
        this.planeTapAnimator.retain(planes.map(plane => plane.id));
    }

    private readyCallback: (() => void) | undefined;

    private lightDir = vec3.create();

    private readonly WIND_COUNT = 10;
    private readonly WIND_SPREAD_X = 300;
    private readonly WIND_SPREAD_Y = 1000;
    private readonly WIND_WONDER = 180;

    private planePresets: PlanePreset[] = [
        { // 0
            name: "01",
            banking: 0.7,
            props: [
                [19, 19, 7.5],
                [-19, 19, 7.5]
            ]
        },
        { // 1
            name: "02",
            banking: 1.0,
            props: [
                [0, 31.5, 12.5]
            ]
        },
        { // 2
            name: "03",
            banking: 0.2,
            props: [
                [21, 29, 8],
                [-21, 29, 8]
            ]
        },
        { // 3
            name: "05",
            banking: 0.2,
            props: [
                [18, 15.5, 24],
                [-18, 15.5, 24]
            ]
        },
        { // 4
            name: "06",
            banking: 1.0,
            props: [
                [0, 35.5, 6]
            ]
        },
        { // 5
            name: "07",
            banking: 0.2,
            props: [
                [0, 35.5, -3]
            ]
        },
        { // 6
            name: "08",
            banking: 0.2,
            props: [
                [19, 11.5, 1],
                [-19, 11.5, 1]
            ]
        },
        { // 7
            name: "09",
            banking: 0.1,
            props: [
                [24, 18.5, -1],
                [-24, 18.5, -1]
            ]
        },
        { // 8
            name: "10",
            banking: 0.8,
            props: [
                [21, 12.5, 0],
                [-21, 12.5, 0]
            ]
        },
    ];

    private cloudsRotation = 0;

    private statePlane = PlaneState.FLY_IN;
    private flyAwaySideDirection = -1;
    private flyAwayForwardSpeed = 0;

    private stateTerrain = TerrainState.NORMAL;

    private nextTerrain = 0;
    private readonly TERRAIN_COUNT = 13;

    constructor() {
        super();

        vec3.normalize(this.lightDir, [-1, -1, 1]);
    }

    setCustomCamera(camera: mat4 | undefined, position?: vec3, rotation?: vec3) {
        this.customCamera = camera;

        if (position !== undefined) {
            this.cameraPosition = position;
        }
        if (rotation !== undefined) {
            this.cameraRotation = rotation;
        }
    }

    resetCustomCamera() {
        this.customCamera = undefined;
    }

    onBeforeInit(): void {
    }

    onAfterInit(): void {
        console.log("====onafterinit");
        const canvas = this.canvas;
        if (canvas === undefined) {
            return;
        }

        canvas.addEventListener("click", (event) => {
            this.handleTap(event.clientX, event.clientY);
        });
    }

    onInitError(): void {
        document.getElementById("canvasGL")?.classList.add("hidden");
        document.getElementById("alertError")?.classList.remove("hidden");
    }

    initShaders(): void {
        this.shaderDiffuse = new DiffuseShader(this.gl);
        this.shaderDiffuseScrollingFiltered = new DiffuseScrollingFilteredShader(this.gl);
        this.shaderDiffuseScrollingFilteredTransition = new DiffuseScrollingFilteredTransitionShader(this.gl);
        this.shaderPlaneBody = new PlaneBodyLitShader(this.gl);
        this.shaderGlass = new GlassShader(this.gl);
        this.shaderWindStripe = new WindStripeShader(this.gl);
    }

    async loadData(): Promise<void> {
        const plane = this.planePresets[this.config.currentPlane];

        await Promise.all([
            this.fmQuad.load("data/models/quad", this.gl),
            this.fmCloud.load("data/models/cloud", this.gl),
            this.fmProp.load("data/models/prop", this.gl),
        ]);

        const models = await this.planeModelCache.acquire(
            this.gl,
            this.config.currentPlane,
            (model, kind) => model.load(`data/models/${plane.name}-${kind}`, this.gl)
        );
        this.fmPlaneBody = models.body;
        this.fmPlaneGlass = models.glass;

        [
            this.textureTerrain,
            this.texturePlane,
            this.textureGlass,
            this.textureCloud,
            this.textureNoise,
        ] = await Promise.all([
            UncompressedTextureLoader.load(`data/textures/ground${this.config.currentTerrain}.webp`, this.gl, this.gl.LINEAR, this.gl.LINEAR, false),
            UncompressedTextureLoader.load(`data/textures/palette${this.config.currentPalette}.png`, this.gl, this.gl.NEAREST, this.gl.NEAREST, true),
            UncompressedTextureLoader.load("data/textures/glass.png", this.gl, this.gl.NEAREST, this.gl.NEAREST, false),
            UncompressedTextureLoader.load("data/textures/clouds.png", this.gl, this.gl.NEAREST, this.gl.NEAREST, false),
            UncompressedTextureLoader.load("data/textures/blue-noise.png", this.gl, this.gl.NEAREST, this.gl.NEAREST, false)
        ]);

        this.loaded = true;
        console.log("Loaded all assets");

        this.readyCallback?.();
    }

    resizeCanvas(): void {
        if (this.canvas === undefined) {
            return;
        }
        super.resizeCanvas();
    }

    async changePlane(preset?: number): Promise<void> {
        if (this.statePlane !== PlaneState.NORMAL) {
            return;
        }

        const newPreset = preset ?? (this.config.currentPlane + 1) % this.planePresets.length;
        if (newPreset === this.config.currentPlane) {
            return;
        }
        const plane = this.planePresets[newPreset];

        this.setPlaneState(PlaneState.FLY_AWAY);

        // Tap animations belong to the outgoing plane models; do not let them
        // run into the newly loaded models.
        this.planeTapAnimator.clear();

        const acquisition = this.planeModelCache.acquire(
            this.gl,
            newPreset,
            (model, kind) => model.load(`data/models/${plane.name}-${kind}`, this.gl)
        );

        let models;
        try {
            await Promise.all([
                new Promise<void>((resolve) => setTimeout(resolve, this.PLANE_TRANSITION_PERIOD)),
                acquisition
            ]);
            models = await acquisition;
        } catch (error) {
            // Loading failed: keep the outgoing model, restore the previous
            // state and re-enable taps instead of leaving the scene stuck.
            console.error(`Failed to load plane preset ${newPreset}`, error);
            this.setPlaneState(PlaneState.FLY_IN);
            return;
        }

        this.fmPlaneBody = models.body;
        this.fmPlaneGlass = models.glass;

        this.config.currentPlane = newPreset;

        // The replacement is in place: release the outgoing plane's GPU
        // resources. The new preset stays resident.
        this.planeModelCache.releaseAllExcept(this.gl, newPreset);

        this.setPlaneState(PlaneState.FLY_IN);
    }

    async changePlanePalette(preset?: number): Promise<void> {
        const newPalette = preset ?? (this.config.currentPalette + 1) % 3;
        const palette = await UncompressedTextureLoader.load(`data/textures/palette${newPalette}.png`, this.gl, this.gl.NEAREST, this.gl.NEAREST, true);
        this.gl.deleteTexture(this.texturePlane!);
        this.texturePlane = palette;
        this.config.currentPalette = newPalette;
    }

    async changeTerrain(preset?: number): Promise<void> {
        if (this.stateTerrain !== TerrainState.NORMAL) {
            return;
        }

        this.nextTerrain = preset ?? (this.config.currentTerrain + 1) % this.TERRAIN_COUNT;
        this.textureTargetTerrain = await UncompressedTextureLoader.load(`data/textures/ground${this.nextTerrain}.webp`, this.gl, this.gl.LINEAR, this.gl.LINEAR, false);
        this.setTerrainState(TerrainState.TRANSITION);
    }

    animate(): void {
        const timeNow = new Date().getTime();
        const deltaTime = this.lastTime === 0 ? 0 : timeNow - this.lastTime;

        if (this.lastTime != 0) {
            this.timerCamera = this.cameraMode === CameraMode.Rotating
                ? (timeNow % this.CAMERA_PERIOD) / this.CAMERA_PERIOD
                : 0.13;

            this.timerGroundMovement = (timeNow % this.GROUND_MOVEMENT_PERIOD) / this.GROUND_MOVEMENT_PERIOD;
            this.timerGroundMovement2 = (timeNow % this.GROUND2_MOVEMENT_PERIOD) / this.GROUND2_MOVEMENT_PERIOD;
            this.timerPlaneWonder1 = (timeNow % this.PLANE_WONDER_PERIOD1) / this.PLANE_WONDER_PERIOD1;
            this.timerPlaneWonder2 = (timeNow % this.PLANE_WONDER_PERIOD2) / this.PLANE_WONDER_PERIOD2;
            this.timerPlaneProp = (timeNow % this.PLANE_PROP_PERIOD) / this.PLANE_PROP_PERIOD;
            this.timerGlass = (timeNow % this.GLASS_PERIOD) / this.GLASS_PERIOD;
            this.timerGlass2 = (timeNow % this.GLASS2_PERIOD) / this.GLASS2_PERIOD;
            this.timerWind = (timeNow % this.WIND_PERIOD) / this.WIND_PERIOD;
            this.timerWind2 = (timeNow % this.WIND_PERIOD2) / this.WIND_PERIOD2;
            this.timerClouds = (timeNow % this.CLOUDS_PERIOD) / this.CLOUDS_PERIOD;

            this.timerPlaneTransition += (timeNow - this.lastTime) / this.PLANE_TRANSITION_PERIOD;
            if (this.timerPlaneTransition > 1.0) {
                this.timerPlaneTransition = 1.0;
                if (this.statePlane === PlaneState.FLY_IN) {
                    this.setPlaneState(PlaneState.NORMAL)
                }
            }
            this.timerTerrainTransition += (timeNow - this.lastTime) / this.TERRAIN_TRANSITION_PERIOD;
            if (this.timerTerrainTransition > 1.0) {
                this.timerTerrainTransition = 1.0;
                if (this.stateTerrain === TerrainState.TRANSITION) {
                    this.swapTerrainTextures();
                    this.setTerrainState(TerrainState.NORMAL);
                }
            }
        }

        this.planeTapAnimator.update(deltaTime);
        this.lastTime = timeNow;
    }

    /** Calculates projection matrix */
    setCameraFOV(multiplier: number): void {
        var ratio;

        if (this.gl.canvas.height > 0) {
            ratio = this.gl.canvas.width / this.gl.canvas.height;
        } else {
            ratio = 1.0;
        }

        let fov = 0;
        if (this.gl.canvas.width >= this.gl.canvas.height) {
            fov = FOV_LANDSCAPE * multiplier;
        } else {
            fov = FOV_PORTRAIT * multiplier;
        }

        this.setFOV(this.mProjMatrix, fov, ratio, this.Z_NEAR, this.Z_FAR);
    }

    private setPlaneState(newState: PlaneState): void {
        if (newState === PlaneState.FLY_AWAY || newState === PlaneState.FLY_IN) {
            this.timerPlaneTransition = 0;
        }

        if (newState === PlaneState.FLY_AWAY) {
            this.flyAwaySideDirection = Math.random() > 0.5 ? 1 : -1;
            this.flyAwayForwardSpeed = (Math.random() - 0.5) * 2.0;
        }

        this.statePlane = newState;
    }

    private setTerrainState(newState: TerrainState): void {
        if (newState === TerrainState.TRANSITION) {
            this.timerTerrainTransition = 0;
        }

        this.stateTerrain = newState;
    }

    /**
     * Calculates camera matrix.
     *
     * @param a Position in [0...1] range
     */
    private positionCamera(a: number) {
        if (this.customCamera !== undefined) {
            this.mVMatrix = this.customCamera;
            return;
        }

        const sina = Math.sin(a * 6.2831852);
        const cosa = Math.cos(a * 6.2831852);
        const x = sina * 200.0 * 1.5;
        const y = cosa * 200.0 * 1.5;
        const z = 250 + (Math.sin(a * 6.2831852) * 50.0) + this.config.planeHeight;

        mat4.lookAt(this.mVMatrix,
            [x, y, z], // eye
            [0, 0, this.config.planeHeight], // center
            [0, 0, 1] // up vector
        );
    }

    /** Issues actual draw calls */
    drawScene() {
        if (!this.loaded) {
            return;
        }

        this.positionCamera(this.timerCamera);
        this.setCameraFOV(1.0);

        this.gl.clearColor(0, 0.56, 0.89, 0);

        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.enable(this.gl.CULL_FACE);
        this.gl.cullFace(this.gl.BACK);

        this.positionCamera(this.timerCamera);
        this.setCameraFOV(1.0);

        this.gl.colorMask(true, true, true, true);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null); // This differs from OpenGL ES
        this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);

        this.drawSceneObjects();
    }

    protected drawVignette(shader: DiffuseShader) {
        this.unbindBuffers();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.mTriangleVerticesVignette!);

        this.gl.enableVertexAttribArray(shader.rm_Vertex!);
        this.gl.vertexAttribPointer(shader.rm_Vertex!, 3, this.gl.FLOAT, false, 20, 0);
        this.gl.enableVertexAttribArray(shader.rm_TexCoord0!);
        this.gl.vertexAttribPointer(shader.rm_TexCoord0!, 2, this.gl.FLOAT, false, 20, 4 * 3);

        this.gl.uniformMatrix4fv(shader.view_proj_matrix!, false, this.getOrthoMatrix());
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    }

    private drawSceneObjects(): void {
        if (this.shaderDiffuse === undefined) {
            console.log("undefined shaders");
            return;
        }

        this.gl.enable(this.gl.CULL_FACE);
        this.gl.cullFace(this.gl.BACK);
        this.gl.disable(this.gl.BLEND);

        this.drawPlanes(this.config.formation);
        this.drawTerrain();

        this.gl.depthMask(false);
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_COLOR);

        this.gl.disable(this.gl.CULL_FACE);
        this.drawWind();
        this.drawClouds();

        this.gl.disable(this.gl.BLEND);
        this.gl.depthMask(true);
    }

    private getGroundSideMovementCoefficient = () =>
        Math.sin(this.timerGroundMovement2 * Math.PI * 2);

    private drawPlanes(formation: Formation): void {
        const planes = this.getFormationPlanes(formation);
        for (const plane of planes) {
            this.drawPlane(plane);
        }
    }

    /** Returns the planes of the given formation in draw order. The first plane is always the center one. */
    private getFormationPlanes(formation: Formation): readonly PlaneInstance[] {
        return getFormationPlanesFor(formation);
    }

    /** Calculates the plane's current world position, including its idle movement. Z already includes the plane height. */
    private getPlanePosition(plane: PlaneInstance): [number, number, number] {
        const time1 = (this.timerPlaneWonder1 + plane.timersOffset) % 1.0;
        const time2 = (this.timerPlaneWonder2 + plane.timersOffset) % 1.0;

        return [
            plane.offset[0] + Math.sin(time1 * 3 * Math.PI * 2) * this.config.planeWonderXY,
            plane.offset[1] + Math.cos(time1 * 5 * Math.PI * 2) * this.config.planeWonderXY,
            plane.offset[2] + Math.cos(time2 * Math.PI * 2) * this.config.planeWonderZ + this.config.planeHeight
        ];
    }

    /**
     * Calculates the position the plane is actually drawn at: its idle position
     * plus its tap animation offsets, if any. Used for hit testing and for the
     * debug screen positions, so both agree with what the user sees.
     */
    private getDrawnPlanePosition(plane: PlaneInstance): [number, number, number] {
        const position = this.getPlanePosition(plane);
        return [
            position[0] + this.planeTapAnimator.getOffsetX(plane.id),
            position[1] + this.planeTapAnimator.getOffsetY(plane.id),
            position[2] + this.planeTapAnimator.getOffsetZ(plane.id)
        ];
    }

    private drawPlane(plane: PlaneInstance): void {
        if (this.shaderPlaneBody === undefined || this.shaderGlass === undefined) {
            return;
        }
        if (this.fmPlaneBody === undefined || this.fmPlaneGlass === undefined) {
            return;
        }

        const planeBody = this.fmPlaneBody;
        const planeGlass = this.fmPlaneGlass;

        const preset = this.planePresets[this.config.currentPlane];

        const timeGlass = (this.timerGlass + plane.timersOffset) % 1.0;
        const timeGlass2 = (this.timerGlass2 + plane.timersOffset) % 1.0;

        const [x0, y0, z0] = this.getDrawnPlanePosition(plane);
        let x = x0;
        let y = y0;
        let z = z0;

        let banking = this.getGroundSideMovementCoefficient() * this.config.planeBanking * preset.banking;
        banking += this.planeTapAnimator.getBankingOffset(plane.id);

        if (this.statePlane === PlaneState.FLY_AWAY) {
            const c1 = Math.pow(this.timerPlaneTransition, 1.5);
            const c2 = Math.pow(this.timerPlaneTransition, 2.5);
            banking += c1 * 0.8 * this.flyAwaySideDirection;
            z += c2 * -50;
            x += c2 * 600 * this.flyAwaySideDirection;
            y += c2 * 400 * this.flyAwayForwardSpeed;
        } else if (this.statePlane === PlaneState.FLY_IN) {
            const c = Math.pow(1.0 - this.timerPlaneTransition, 2.5);
            z += c * 200;
            y += c * -200;
        }

        const drawProp = (propOffsetX: number, propOffsetY: number, propOffsetZ: number, time: number) => {
            let propX = Math.sin(banking + Math.PI / 2) * propOffsetX;
            let propZ = Math.cos(banking + Math.PI / 2) * propOffsetX;

            propX += Math.sin(banking) * propOffsetZ;
            propZ += Math.cos(banking) * propOffsetZ;

            this.shaderPlaneBody!.drawModel(
                this,
                this.fmProp,
                propX + x, y + propOffsetY, propZ + z,
                0, time * Math.PI * 2, 0,
                1, 1, 1
            );
        };

        this.shaderGlass.use();
        this.setTexture2D(0, this.textureGlass!, this.shaderGlass.sTexture!);
        this.gl.uniform4f(this.shaderGlass.lightDir!, this.lightDir[0], this.lightDir[1], this.lightDir[2], 0);
        this.gl.uniform4f(this.shaderGlass.ambient!, 0.5, 0.5, 0.5, 0);
        this.gl.uniform4f(this.shaderGlass.diffuse!, 1, 1, 1, 0);
        this.gl.uniform1f(this.shaderGlass.diffuseCoef!, 1.0);
        this.gl.uniform1f(this.shaderGlass.diffuseExponent!, 1.0);
        this.gl.uniform4f(this.shaderGlass.vColor!, 0.6, 0.6, 1.0, 0);
        this.gl.uniform1f(this.shaderGlass.uTime!, Math.sin(timeGlass2 * Math.PI * 2) > 0 ? timeGlass : 0.2);

        this.shaderGlass.drawModel(
            this,
            planeGlass,
            x, y, z,
            0, banking, 0,
            1, 1, 1
        );

        this.shaderPlaneBody.use();
        this.setTexture2D(0, this.texturePlane!, this.shaderPlaneBody.sTexture!);
        this.gl.uniform4f(this.shaderPlaneBody.lightDir!, this.lightDir[0], this.lightDir[1], this.lightDir[2], 0);
        this.gl.uniform4f(this.shaderPlaneBody.ambient!, 0.5, 0.5, 0.5, 0);
        this.gl.uniform4f(this.shaderPlaneBody.diffuse!, 1, 1, 1, 0);
        this.gl.uniform1f(this.shaderPlaneBody.diffuseCoef!, 1.0);
        this.gl.uniform1f(this.shaderPlaneBody.diffuseExponent!, 1.0);

        for (let i = 0; i < preset.props.length; i++) {
            const prop = preset.props[i];
            const time = (this.timerPlaneProp + plane.propTimerOffset + i * 0.23) % 1.0;
            drawProp(prop[0], prop[1], prop[2], time);
        }

        this.shaderPlaneBody.drawModel(
            this,
            planeBody,
            x, y, z,
            0, banking, 0,
            1, 1, 1
        );
    }

    /** Handles a tap at the given client coordinates. */
    private handleTap(clientX: number, clientY: number): void {
        if (this.statePlane !== PlaneState.NORMAL) {
            return;
        }

        const ground = this.getTapGroundIntersection(clientX, clientY);
        if (ground === null) {
            return;
        }

        const camera: [number, number, number] = [this.vecTapCamera[0], this.vecTapCamera[1], this.vecTapCamera[2]];
        const forward: [number, number, number] = [
            this.vecTapFar[0] - camera[0],
            this.vecTapFar[1] - camera[1],
            this.vecTapFar[2] - camera[2]
        ];
        const groundPoint: [number, number, number] = [ground[0], ground[1], ground[2]];

        // Resolve the hit against the formation which is currently drawn, using
        // the same plane instances that are drawn, and key the animation by the
        // hit plane's identity rather than by its draw order index.
        const planes = this.getFormationPlanes(this.config.formation);
        const positions = planes.map(plane => this.getDrawnPlanePosition(plane));
        const hitPlane = findTappedPlane(planes, positions, camera, forward, groundPoint, this.TAP_HIT_RADIUS);

        if (hitPlane !== null) {
            this.planeTapAnimator.tap(hitPlane.id);
        }
    }

    /**
     * Casts a ray from the camera through the given client coordinates and
     * returns its intersection with the horizontal plane at z = 0.
     */
    private getTapGroundIntersection(clientX: number, clientY: number): vec3 | null {
        const canvas = this.canvas;
        if (canvas === undefined) {
            return null;
        }

        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return null;
        }

        mat4.multiply(this.matTapViewProjection, this.mProjMatrix, this.mVMatrix);
        if (mat4.invert(this.matTapViewProjectionInverted, this.matTapViewProjection) === null
            || mat4.invert(this.matTapViewInverted, this.mVMatrix) === null) {
            return null;
        }
        mat4.getTranslation(this.vecTapCamera, this.matTapViewInverted);

        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;

        vec3.set(this.vecTapFar, ndcX, ndcY, 1);
        vec3.transformMat4(this.vecTapFar, this.vecTapFar, this.matTapViewProjectionInverted);

        return findLinePlaneIntersectionCoords(
            this.vecTapCamera[0], this.vecTapCamera[1], this.vecTapCamera[2],
            this.vecTapFar[0], this.vecTapFar[1], this.vecTapFar[2],
            0, 0, 1, 0, // Horizontal plane z = 0.
            this.vecTapGround
        );
    }

    private drawWind(): void {
        if (this.shaderWindStripe === undefined) {
            return;
        }

        this.shaderWindStripe.use();
        this.gl.uniform4f(this.shaderWindStripe.uColor!, 0.18, 0.18, 0.18, 1.0);

        for (let i = 0; i < this.WIND_COUNT; i++) {
            const o = (Math.sin(i / this.WIND_COUNT * Math.PI * 22) + 1) * 0.5;
            const time = (this.timerWind + i / this.WIND_COUNT) % 1.0;
            let x = -this.WIND_SPREAD_X + o * this.WIND_SPREAD_X * 2;
            x += Math.cos(this.timerWind2 * Math.PI * 2) * this.WIND_WONDER;
            const y = this.WIND_SPREAD_Y - this.WIND_SPREAD_Y * 2 * time;
            const z = this.config.planeHeight * (i % 2 ? 0.75 : 1.25);

            this.shaderWindStripe.draw(
                this,
                x, y, z,
                0, 0, 0,
                0.03, 0.6, 1
            );
        }
    }

    private drawTerrain(): void {
        if (this.shaderDiffuseScrollingFiltered === undefined || this.shaderDiffuseScrollingFilteredTransition === undefined) {
            return;
        }

        let shader: DiffuseScrollingShader;

        if (this.stateTerrain === TerrainState.NORMAL) {
            shader = this.shaderDiffuseScrollingFiltered;
            shader.use();
        } else {
            shader = this.shaderDiffuseScrollingFilteredTransition;
            shader.use();
            this.setTexture2D(1, this.textureTargetTerrain!, this.shaderDiffuseScrollingFilteredTransition.sTargetTexture!);
            this.setTexture2D(2, this.textureNoise!, this.shaderDiffuseScrollingFilteredTransition.sMaskTexture!);
            this.gl.uniform1f(this.shaderDiffuseScrollingFilteredTransition.uTransition!, this.timerTerrainTransition);
        }

        this.setTexture2D(0, this.textureTerrain!, shader.sTexture!);
        this.gl.uniform3f(
            shader.uUvOffset!,
            this.getGroundSideMovementCoefficient() * 0.2,
            -this.timerGroundMovement,
            3.8
        );

        shader.drawModel(
            this,
            this.fmQuad,
            0, 0, 0,
            0, 0, 0,
            30, 30, 30
        );
    }

    private swapTerrainTextures(): void {
        const texture = this.textureTerrain!;
        this.gl.deleteTexture(texture);
        this.textureTerrain = this.textureTargetTerrain;
        this.textureTargetTerrain = undefined;
        this.config.currentTerrain = this.nextTerrain;
    }

    private drawClouds(): void {
        if (this.shaderDiffuse === undefined) {
            return;
        }

        this.shaderDiffuse?.use();
        this.setTexture2D(0, this.textureCloud!, this.shaderDiffuse.sTexture!);

        const time = this.timerClouds;
        if (time < 0.01) {
            this.cloudsRotation = 2.0 * Math.PI * (Math.floor(Math.random() * 4.0) / 4.0);
        }

        const x = 0;
        const y = this.WIND_SPREAD_Y - this.WIND_SPREAD_Y * 2 * time;
        const z = this.config.planeHeight * 1.7;

        this.shaderDiffuse.drawModel(
            this,
            this.fmCloud,
            x, y, z,
            0, 0, this.cloudsRotation,
            9, 9, 9
        );
    }

    public changeCameraMode(): void {
        if (this.cameraMode === CameraMode.Fixed) {
            this.cameraMode = CameraMode.Rotating
        } else {
            this.cameraMode = CameraMode.Fixed;
        }
    }

    public checkGlError(operation: string): void {
        // Do nothing in production build.
    }

    /** Whether taps are currently accepted (false while the plane model is changing). */
    public get isTapEnabled(): boolean {
        return this.statePlane === PlaneState.NORMAL;
    }

    /**
     * Snapshot of the tap/formation/model state, used by automated browser
     * checks to observe animation ownership and GPU resource usage without
     * reaching into private fields.
     */
    public getDebugState(): RendererDebugState {
        const formation = this.config.formation;
        const planes = this.getFormationPlanes(formation);

        return {
            formation,
            currentPlane: this.config.currentPlane,
            currentPalette: this.config.currentPalette,
            currentTerrain: this.config.currentTerrain,
            planeState: PlaneState[this.statePlane],
            tapEnabled: this.isTapEnabled,
            formationPlaneIds: planes.map(plane => plane.id),
            animatedPlaneIds: planes.filter(plane => this.planeTapAnimator.isAnimating(plane.id)).map(plane => plane.id),
            planeModel: {
                residentPresets: this.planeModelCache.getResidentPresets(),
                liveBuffers: PlaneModel.getLiveBufferCount(),
                createdBuffers: PlaneModel.getCreatedBufferCount()
            }
        };
    }

    public set ready(callback: () => void) {
        this.readyCallback = callback;
    }

    /**
     * Screen coordinates (in client pixels) of the drawn planes' centers,
     * letting automated browser checks click real planes instead of guessing
     * coordinates. Planes behind the camera are reported with `visible: false`.
     */
    public getPlaneScreenPositions(): PlaneScreenPosition[] {
        const canvas = this.canvas;
        if (canvas === undefined) {
            return [];
        }

        const rect = canvas.getBoundingClientRect();
        mat4.multiply(this.matTapViewProjection, this.mProjMatrix, this.mVMatrix);
        if (mat4.invert(this.matTapViewProjectionInverted, this.matTapViewProjection) === null) {
            return [];
        }

        const planes = this.getFormationPlanes(this.config.formation);
        const result: PlaneScreenPosition[] = [];
        const clip = vec4.create();

        for (const plane of planes) {
            const position = this.getDrawnPlanePosition(plane);
            vec4.set(clip, position[0], position[1], position[2], 1);
            vec4.transformMat4(clip, clip, this.matTapViewProjection);

            const w = clip[3];
            const inFrontOfCamera = w > 0;
            const visible = inFrontOfCamera && clip[2] > -w && clip[2] < w;
            const ndcX = clip[0] / w;
            const ndcY = clip[1] / w;

            result.push({
                id: plane.id,
                x: rect.left + ((ndcX + 1) / 2) * rect.width,
                y: rect.top + ((1 - ndcY) / 2) * rect.height,
                visible
            });
        }

        return result;
    }
}

/** Screen position of a drawn plane, for automated checks. */
export interface PlaneScreenPosition {
    id: string;
    /** Client-space X coordinate of the plane center. */
    x: number;
    /** Client-space Y coordinate of the plane center. */
    y: number;
    visible: boolean;
}

/** Machine-readable state for automated browser checks. */
export interface RendererDebugState {
    formation: Formation;
    currentPlane: number;
    currentPalette: number;
    currentTerrain: number;
    planeState: string;
    tapEnabled: boolean;
    /** Plane identities currently drawn, in draw order. */
    formationPlaneIds: string[];
    /** Plane identities currently playing a tap animation. */
    animatedPlaneIds: string[];
    planeModel: {
        /** Presets whose models are resident (not disposed). */
        residentPresets: number[];
        /** WebGL buffers currently alive for plane models. */
        liveBuffers: number;
        /** WebGL buffers created for plane models since page load. */
        createdBuffers: number;
    };
}
