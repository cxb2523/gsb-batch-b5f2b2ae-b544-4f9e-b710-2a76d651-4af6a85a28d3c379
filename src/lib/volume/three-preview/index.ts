import type { WebGLRenderer } from 'three';
import type { PreparedVolumeFor3D, VolumeCursor } from '../../../types';
import type {
  ThreeModule,
  ThreePreviewInstance,
  TrackballControlsModule,
  VolumeShaderModule,
} from '../types';
import {
  applyDistanceLimits,
  cursorToWorldTarget,
  resolveAxisScale,
} from './camera';
import { buildCursorPlanes } from './cursor-planes';
import {
  buildColormap,
  buildMaterial,
  buildTexture,
  buildVolumeMesh,
  disposeVolumeResources,
} from './volume-object';

type TrackballControlsInstance = InstanceType<
  TrackballControlsModule['TrackballControls']
>;

export type { ThreePreviewInstance } from '../types';

/**
 * Thrown (or used to reject) when a preview build is cancelled before it can
 * finish. Mirrors the DOM `AbortError` shape so callers can branch on
 * `error.name === 'AbortError'` regardless of where cancellation happened.
 */
export class PreviewAbortError extends Error {
  constructor(message = 'Preview creation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export interface CreateThreePreviewOptions {
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PreviewAbortError();
  }
}

export async function createThreePreview(
  host: HTMLDivElement,
  volume: PreparedVolumeFor3D,
  options: CreateThreePreviewOptions = {},
): Promise<ThreePreviewInstance> {
  const { signal } = options;
  throwIfAborted(signal);

  let modules: [ThreeModule, TrackballControlsModule, VolumeShaderModule];
  try {
    modules = await Promise.all([
      import('three'),
      import('three/addons/controls/TrackballControls.js'),
      import('three/addons/shaders/VolumeShader.js'),
    ]);
  } catch (error) {
    if (signal?.aborted) {
      throw new PreviewAbortError();
    }
    throw error;
  }

  // Cancellation may have landed while the dynamic imports were in flight.
  throwIfAborted(signal);

  const [three, trackballControls, volumeShader] = modules;
  return buildPreview(
    three,
    trackballControls,
    volumeShader,
    host,
    volume,
    signal,
  );
}

function buildPreview(
  three: ThreeModule,
  trackballControls: TrackballControlsModule,
  volumeShader: VolumeShaderModule,
  host: HTMLDivElement,
  volume: PreparedVolumeFor3D,
  signal: AbortSignal | undefined,
): ThreePreviewInstance {
  // Every GPU resource is tracked up front so a synchronous failure anywhere
  // in the build can release exactly what was allocated up to that point.
  let renderer: WebGLRenderer | null = null;
  let controls: TrackballControlsInstance | null = null;
  let texture: ReturnType<typeof buildTexture> | null = null;
  let colormap: ReturnType<typeof buildColormap> | null = null;
  let material: ReturnType<typeof buildMaterial> | null = null;
  let mesh: ReturnType<typeof buildVolumeMesh> | null = null;
  let cursorPlanes: ReturnType<typeof buildCursorPlanes> | null = null;
  let motionPreference: MediaQueryList | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let frame = 0;
  let disposed = false;
  let canvas: HTMLCanvasElement | null = null;

  const syncMotionPreference = () => {
    if (controls && motionPreference) {
      controls.staticMoving = motionPreference.matches;
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;

    window.cancelAnimationFrame(frame);
    if (motionPreference) {
      motionPreference.removeEventListener('change', syncMotionPreference);
    }
    resizeObserver?.disconnect();
    controls?.dispose();
    cursorPlanes?.dispose();
    disposeVolumeResources({ texture, colormap, material, mesh });
    if (renderer) {
      renderer.dispose();
      // Free the underlying WebGL context immediately; browsers otherwise
      // keep contexts alive until their hard per-page limit is reached,
      // which leaks across rapid volume switches.
      renderer.forceContextLoss();
    }
    if (canvas && canvas.parentElement === host) {
      host.removeChild(canvas);
    }
  };

  try {
    const scene = new three.Scene();
    scene.background = new three.Color(0x050b13);

    renderer = new three.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    throwIfAborted(signal);
    const targetCanvas = renderer.domElement;
    canvas = targetCanvas;
    targetCanvas.style.display = 'block';
    targetCanvas.style.width = '100%';
    targetCanvas.style.height = '100%';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
    renderer.setSize(
      Math.max(1, host.clientWidth),
      Math.max(1, host.clientHeight),
      false,
    );
    renderer.outputColorSpace = three.SRGBColorSpace;
    renderer.setClearColor(0x050b13, 1);
    // Append only our own canvas; never clear the host here because another
    // (newer) mount may already own it during a rapid volume switch.
    host.appendChild(targetCanvas);

    const camera = new three.PerspectiveCamera(
      12,
      Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
      0.1,
      500,
    );

    controls = new trackballControls.TrackballControls(camera, targetCanvas);
    controls.rotateSpeed = 0.95;
    controls.zoomSpeed = 1.05;
    controls.panSpeed = 0.3;
    controls.dynamicDampingFactor = 0.18;
    motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    syncMotionPreference();
    motionPreference.addEventListener('change', syncMotionPreference);
    controls.noPan = true;
    controls.minDistance = 1.2;
    controls.maxDistance = 10;

    texture = buildTexture(three, volume);
    colormap = buildColormap(three);
    material = buildMaterial(three, volumeShader, volume, texture, colormap);
    mesh = buildVolumeMesh(three, volume, material);
    scene.add(mesh);

    const axisScale = resolveAxisScale(volume.spacing);
    mesh.scale.set(axisScale[0], axisScale[1], axisScale[2]);

    const worldSize = [
      Math.max(1, volume.dimensions[0] - 1) * axisScale[0],
      Math.max(1, volume.dimensions[1] - 1) * axisScale[1],
      Math.max(1, volume.dimensions[2] - 1) * axisScale[2],
    ] as const;
    const maxWorldEdge = Math.max(...worldSize) || 1;

    const center = new three.Vector3(
      ((volume.dimensions[0] - 1) / 2) * axisScale[0],
      ((volume.dimensions[1] - 1) / 2) * axisScale[1],
      ((volume.dimensions[2] - 1) / 2) * axisScale[2],
    );
    cursorPlanes = buildCursorPlanes(three, worldSize, center);
    scene.add(cursorPlanes.root);
    camera.near = Math.max(0.1, maxWorldEdge / 2048);

    const initialTarget = center.clone();
    const initialOffset = new three.Vector3(
      maxWorldEdge * 0.68,
      -maxWorldEdge * 2.9,
      maxWorldEdge * 4.25,
    );
    let currentTarget = initialTarget.clone();
    const resetCameraView = () => {
      const activeControls = controls;
      const activePlanes = cursorPlanes;
      if (!activeControls || !activePlanes) return;
      camera.up.set(0, 1, 0);
      camera.position.copy(currentTarget).add(initialOffset);
      camera.lookAt(currentTarget);
      applyDistanceLimits(camera, activeControls, worldSize, currentTarget);
      activeControls.target.copy(currentTarget);
      activePlanes.update(currentTarget);
      activeControls.update();
    };
    resetCameraView();

    resizeObserver = new ResizeObserver(() => {
      if (disposed || !renderer) return;
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      controls?.handleResize();
    });
    resizeObserver.observe(host);
    controls.handleResize();

    const render = () => {
      // Check before rescheduling: if dispose ran between the browser
      // dequeuing this frame and the callback running, cancelAnimationFrame
      // came too late for the current handle, so stop the loop here instead
      // of rendering into a lost context and scheduling another frame.
      if (disposed) return;
      frame = window.requestAnimationFrame(render);
      controls?.update();
      if (renderer) {
        renderer.render(scene, camera);
      }
    };
    render();

    return {
      focusCursor(cursor: VolumeCursor | null) {
        const activeControls = controls;
        const activePlanes = cursorPlanes;
        if (disposed || !activeControls || !activePlanes) return;
        if (!cursor) {
          currentTarget = initialTarget.clone();
          activePlanes.update(currentTarget);
          return;
        }

        const target = cursorToWorldTarget(three, volume, axisScale, cursor);
        currentTarget = target;
        applyDistanceLimits(camera, activeControls, worldSize, currentTarget);
        activeControls.target.copy(currentTarget);
        activePlanes.update(currentTarget);
        camera.lookAt(currentTarget);
        activeControls.update();
      },
      resetView() {
        if (!disposed) resetCameraView();
      },
      rotateView(horizontalRadians, verticalRadians) {
        const activeControls = controls;
        if (disposed || !activeControls) return;
        const offset = camera.position.clone().sub(currentTarget);
        const spherical = new three.Spherical().setFromVector3(offset);
        spherical.theta += horizontalRadians;
        spherical.phi = Math.min(
          Math.PI - 0.05,
          Math.max(0.05, spherical.phi + verticalRadians),
        );
        offset.setFromSpherical(spherical);
        camera.up.set(0, 1, 0);
        camera.position.copy(currentTarget).add(offset);
        camera.lookAt(currentTarget);
        activeControls.target.copy(currentTarget);
        activeControls.update();
      },
      setPlanesVisible(visible) {
        if (cursorPlanes) {
          cursorPlanes.root.visible = visible;
        }
      },
      zoomView(factor) {
        const activeControls = controls;
        if (disposed || !activeControls) return;
        const offset = camera.position.clone().sub(currentTarget);
        const distance = Math.min(
          activeControls.maxDistance,
          Math.max(activeControls.minDistance, offset.length() * factor),
        );
        offset.setLength(distance);
        camera.position.copy(currentTarget).add(offset);
        camera.lookAt(currentTarget);
        activeControls.target.copy(currentTarget);
        activeControls.update();
      },
      dispose,
    };
  } catch (error) {
    // A failed build must never leave a renderer, texture or canvas behind.
    dispose();
    if (signal?.aborted) {
      throw new PreviewAbortError();
    }
    throw error;
  }
}
