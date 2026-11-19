// 测试公共工具：DOM/rAF 桩 + ClusterRenderer 线束（harness）。
//
// ClusterRenderer 的构造函数依赖 WebGL 上下文，Node 环境无法创建。
// 这里用 Object.create(ClusterRenderer.prototype) 绕过构造，
// 手动装配同步/生命周期逻辑真正依赖的字段，从而可以在本地验证
// syncWithState / start / stop / dispose 的真实行为。

import * as THREE from 'three';
import { ClusterRenderer } from '../js/rendering/ClusterRenderer.js';
import { ResourceMeshFactory } from '../js/rendering/ResourceMeshes.js';
import { ConnectionLineManager } from '../js/rendering/ConnectionLines.js';
import { ParticleTrafficSystem } from '../js/rendering/ParticleTraffic.js';

// ---- requestAnimationFrame / cancelAnimationFrame 桩 ----
const pendingFrames = new Map();
let nextFrameId = 1;

globalThis.requestAnimationFrame = (cb) => {
    const id = nextFrameId++;
    pendingFrames.set(id, cb);
    return id;
};
globalThis.cancelAnimationFrame = (id) => {
    pendingFrames.delete(id);
};

export function pendingFrameCount() {
    return pendingFrames.size;
}

export function flushPendingFrames() {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    for (const cb of callbacks) cb(performance.now());
}

// ---- DOM 桩（标签纹理绘制需要 canvas 2d 上下文）----
function create2dContextStub() {
    return new Proxy({}, {
        get(target, prop) {
            if (prop === 'measureText') return () => ({ width: 42 });
            return () => {};
        },
        set() { return true; }
    });
}

if (!globalThis.document) {
    globalThis.document = {
        createElement(tag) {
            return {
                tagName: String(tag).toUpperCase(),
                width: 0,
                height: 0,
                style: {},
                getContext: () => create2dContextStub(),
                addEventListener() {},
                removeEventListener() {},
            };
        }
    };
}

if (!globalThis.window) {
    const removedListeners = [];
    globalThis.window = {
        devicePixelRatio: 1,
        removedListeners,
        addEventListener() {},
        removeEventListener(type) { removedListeners.push(type); },
    };
}

export function createFakeCanvas() {
    const removedListeners = [];
    return {
        style: {},
        clientWidth: 800,
        clientHeight: 600,
        removedListeners,
        addEventListener() {},
        removeEventListener(type) { removedListeners.push(type); },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    };
}

export function createRendererHarness() {
    const r = Object.create(ClusterRenderer.prototype);

    r.canvas = createFakeCanvas();
    r.scene = new THREE.Scene();
    r.camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 500);
    r.raycaster = new THREE.Raycaster();
    r.pickableObjects = [];
    r.mouse = new THREE.Vector2(-999, -999);

    r.resourceMeshes = new Map();
    r.namespacePlanes = new Map();
    r.namespaceColorIndex = 0;
    r.selectedResource = null;
    r.hoveredResource = null;
    r.onSelect = null;
    r.onHover = null;
    r.onResourceMoved = null;

    r._didDrag = false;
    r._draggingResource = null;
    r._dragCandidate = null;
    r._clickStart = new THREE.Vector2();
    r._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    r.running = false;
    r.frameId = null;
    r._tweenFrameId = null;
    r._disposed = false;
    r.lastFrameTime = 0;

    r.meshFactory = new ResourceMeshFactory();
    r.connectionLines = new ConnectionLineManager(r.scene);
    r.particleTraffic = new ParticleTrafficSystem(r.scene);

    r.controls = {
        enabled: true,
        target: new THREE.Vector3(),
        disposeCount: 0,
        update() {},
        dispose() { this.disposeCount++; },
    };
    r.renderer = {
        renderCount: 0,
        disposeCount: 0,
        render() { this.renderCount++; },
        dispose() { this.disposeCount++; },
    };

    // dispose() 需要解绑的监听器引用
    r._onMouseMove = () => {};
    r._onMouseDown = () => {};
    r._onMouseUp = () => {};
    r._onResize = () => {};
    r._onContextMenu = () => {};

    return r;
}

// ---- 状态构造工具 ----
export function makeResource(id, type, name, namespace = 'default', x = 0, z = 0) {
    return { id, type, name, namespace, status: 'Running', x, y: 0, z };
}

export function makeConnection(id, sourceId, targetId, type = 'network') {
    return { id, sourceId, targetId, type, trafficVolume: 1 };
}

export function makeRoute(id, sourceId, targetId) {
    return {
        id,
        sourceId,
        targetId,
        sourcePos: { x: 0, y: 0, z: 0 },
        targetPos: { x: 3, y: 0, z: 0 },
        trafficType: 'healthy',
        requestRate: 5,
    };
}

export function makeState({ resources = [], connections = [], trafficRoutes = [] }) {
    return {
        resources: new Map(resources.map(r => [r.id, r])),
        connections: new Map(connections.map(c => [c.id, c])),
        trafficRoutes: new Map(trafficRoutes.map(r => [r.id, r])),
    };
}

export function findLabelTexture(group) {
    let texture = null;
    group.traverse((child) => {
        if (child.userData.isLabel && child.material?.map && !texture) {
            texture = child.material.map;
        }
    });
    return texture;
}
