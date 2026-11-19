// 场景二：源或目标资源缺失时，连线与流量路由必须被移除而不是静默保留。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ConnectionLineManager } from '../js/rendering/ConnectionLines.js';
import { ParticleTrafficSystem } from '../js/rendering/ParticleTraffic.js';
import {
    createRendererHarness,
    makeState,
    makeResource,
    makeConnection,
    makeRoute,
} from './helpers.mjs';

test('ConnectionLineManager.sync 移除端点资源缺失的连线', () => {
    const scene = new THREE.Scene();
    const mgr = new ConnectionLineManager(scene);
    const meshes = new Map([
        ['m1', new THREE.Group()],
        ['m2', new THREE.Group()],
    ]);

    const conns = new Map([
        ['c1', makeConnection('c1', 'm1', 'm2')],
    ]);
    mgr.sync(conns, meshes);
    assert.equal(mgr.getConnectionCount(), 1);

    // 目标资源消失后，即使状态仍声明该连线，也必须被清理
    meshes.delete('m2');
    mgr.sync(conns, meshes);
    assert.equal(mgr.getConnectionCount(), 0);
    assert.equal(mgr.lineGroup.children.length, 0);

    mgr.dispose();
});

test('ConnectionLineManager.addConnection 在端点缺失时不创建条目', () => {
    const scene = new THREE.Scene();
    const mgr = new ConnectionLineManager(scene);
    const meshes = new Map([['m1', new THREE.Group()]]);

    mgr.addConnection(makeConnection('c9', 'm1', 'missing'), meshes);
    assert.equal(mgr.getConnectionCount(), 0);

    mgr.dispose();
});

test('ConnectionLineManager.removeConnectionsForResource 级联清理', () => {
    const scene = new THREE.Scene();
    const mgr = new ConnectionLineManager(scene);
    const meshes = new Map([
        ['m1', new THREE.Group()],
        ['m2', new THREE.Group()],
        ['m3', new THREE.Group()],
    ]);

    mgr.addConnection(makeConnection('c1', 'm1', 'm2'), meshes);
    mgr.addConnection(makeConnection('c2', 'm2', 'm3'), meshes);
    mgr.addConnection(makeConnection('c3', 'm1', 'm3'), meshes);
    assert.equal(mgr.getConnectionCount(), 3);

    mgr.removeConnectionsForResource('m2');
    assert.equal(mgr.getConnectionCount(), 1);
    assert.ok(mgr.connections.has('c3'));

    mgr.dispose();
});

test('ParticleTrafficSystem.syncRoutes 移除端点缺失的路由并回收粒子', () => {
    const scene = new THREE.Scene();
    const sys = new ParticleTrafficSystem(scene);

    const routes = new Map([['r1', makeRoute('r1', 'm1', 'm2')]]);
    sys.syncRoutes(routes, new Set(['m1', 'm2']));
    assert.equal(sys.getRouteCount(), 1);

    sys.update(1.0); // 让路由产生一些粒子
    assert.ok(sys.getActiveParticleCount() > 0);

    // m2 缺失：路由必须被移除，关联粒子被回收
    sys.syncRoutes(routes, new Set(['m1']));
    assert.equal(sys.getRouteCount(), 0);
    sys.update(0.1);
    assert.equal(sys.getActiveParticleCount(), 0);

    sys.dispose();
});

test('ParticleTrafficSystem.removeRoutesForResource 级联清理', () => {
    const scene = new THREE.Scene();
    const sys = new ParticleTrafficSystem(scene);

    sys.addRoute(makeRoute('r1', 'm1', 'm2'));
    sys.addRoute(makeRoute('r2', 'm2', 'm3'));
    sys.addRoute(makeRoute('r3', 'm1', 'm3'));
    assert.equal(sys.getRouteCount(), 3);

    sys.removeRoutesForResource('m2');
    assert.equal(sys.getRouteCount(), 1);
    assert.ok(sys.routes.has('r3'));

    sys.dispose();
});

test('ClusterRenderer.removeResource 级联清理该资源的连线与路由', () => {
    const r = createRendererHarness();

    r.syncWithState(makeState({
        resources: [
            makeResource('a', 'Pod', 'p1', 'default', 0, 0),
            makeResource('b', 'Pod', 'p2', 'default', 2, 0),
        ],
        connections: [makeConnection('c1', 'a', 'b')],
        trafficRoutes: [makeRoute('r1', 'a', 'b')],
    }));
    assert.equal(r.connectionLines.getConnectionCount(), 1);
    assert.equal(r.particleTraffic.getRouteCount(), 1);

    r.removeResource('b');

    assert.equal(r.connectionLines.getConnectionCount(), 0);
    assert.equal(r.particleTraffic.getRouteCount(), 0);
});
