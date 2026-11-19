// 场景一：集群状态整体替换（切换关卡 / 重置集群）。
// 验证 syncWithState 在批量移除+新增后，连线、流量路由、命名空间地面
// 都收敛到与新 ClusterState 一致，且同帧先删后加同名资源时只显示新资源。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRendererHarness,
    makeState,
    makeResource,
    makeConnection,
    makeRoute,
    findLabelTexture,
} from './helpers.mjs';

test('批量替换：旧资源的连线/流量路由/命名空间地面被清理并按新状态重建', () => {
    const r = createRendererHarness();

    r.syncWithState(makeState({
        resources: [
            makeResource('a', 'Pod', 'web-pod', 'apps', 0, 0),
            makeResource('b', 'Service', 'web-svc', 'apps', 3, 0),
        ],
        connections: [makeConnection('net:a:b', 'a', 'b')],
        trafficRoutes: [makeRoute('r1', 'a', 'b')],
    }));

    assert.equal(r.resourceMeshes.size, 2);
    assert.equal(r.connectionLines.getConnectionCount(), 1);
    assert.equal(r.particleTraffic.getRouteCount(), 1);
    assert.deepEqual([...r.namespacePlanes.keys()], ['apps']);

    const oldGroupA = r.resourceMeshes.get('a');

    // 整体替换：a、b 全部移除，c、d 新增
    r.syncWithState(makeState({
        resources: [
            makeResource('c', 'Pod', 'api-pod', 'web', 0, 3),
            makeResource('d', 'Deployment', 'api-dep', 'web', 3, 3),
        ],
        connections: [makeConnection('own:c:d', 'c', 'd', 'ownership')],
        trafficRoutes: [makeRoute('r2', 'c', 'd')],
    }));

    // 网格集合与新状态一致
    assert.deepEqual([...r.resourceMeshes.keys()].sort(), ['c', 'd']);
    // 旧连线被清理，只剩新连线
    assert.deepEqual([...r.connectionLines.connections.keys()], ['own:c:d']);
    // 旧流量路由被清理，只剩新路由
    assert.deepEqual([...r.particleTraffic.routes.keys()], ['r2']);
    // 旧命名空间地面被移除，只剩新命名空间
    assert.deepEqual([...r.namespacePlanes.keys()], ['web']);
    // 旧网格已从场景移除
    assert.ok(!r.scene.children.includes(oldGroupA));
});

test('同一帧内先删后加同名资源，最终视图只显示新资源', () => {
    const r = createRendererHarness();

    r.syncWithState(makeState({
        resources: [makeResource('old-uid', 'Pod', 'nginx', 'default')],
    }));
    const oldTexture = findLabelTexture(r.resourceMeshes.get('old-uid'));
    let oldTextureDisposed = false;
    oldTexture.addEventListener('dispose', () => { oldTextureDisposed = true; });

    // 同名（不同 uid）的新资源替换旧资源
    r.syncWithState(makeState({
        resources: [makeResource('new-uid', 'Pod', 'nginx', 'default')],
    }));

    assert.equal(r.resourceMeshes.size, 1);
    assert.ok(r.resourceMeshes.has('new-uid'));
    assert.equal(r.resourceMeshes.get('new-uid').userData.resourceId, 'new-uid');

    // 同名标签共享同一纹理，且旧资源移除时未误删共享纹理
    const newTexture = findLabelTexture(r.resourceMeshes.get('new-uid'));
    assert.equal(newTexture, oldTexture);
    assert.equal(oldTextureDisposed, false);
});

test('同 id 但类型不同的资源被视为替换，重建网格', () => {
    const r = createRendererHarness();

    r.syncWithState(makeState({
        resources: [makeResource('x', 'Pod', 'thing', 'default')],
    }));
    assert.equal(r.resourceMeshes.get('x').userData.resourceType, 'Pod');

    r.syncWithState(makeState({
        resources: [makeResource('x', 'Service', 'thing', 'default')],
    }));
    assert.equal(r.resourceMeshes.size, 1);
    assert.equal(r.resourceMeshes.get('x').userData.resourceType, 'Service');
});

test('状态未提供连线/路由字段时，端点已缺失的条目也被清除', () => {
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

    // 第二次同步只提供 resources（模拟重置后状态对象不含连线/路由集合）
    r.syncWithState({
        resources: new Map([['a', makeResource('a', 'Pod', 'p1', 'default')]]),
    });

    assert.deepEqual([...r.resourceMeshes.keys()], ['a']);
    assert.equal(r.connectionLines.getConnectionCount(), 0);
    assert.equal(r.particleTraffic.getRouteCount(), 0);
});

test('重置为空状态后场景完全收敛', () => {
    const r = createRendererHarness();

    r.syncWithState(makeState({
        resources: [
            makeResource('a', 'Pod', 'p1', 'apps', 0, 0),
            makeResource('b', 'Service', 's1', 'apps', 3, 0),
        ],
        connections: [makeConnection('c1', 'a', 'b')],
        trafficRoutes: [makeRoute('r1', 'a', 'b')],
    }));

    r.syncWithState(makeState({}));

    assert.equal(r.resourceMeshes.size, 0);
    assert.equal(r.connectionLines.getConnectionCount(), 0);
    assert.equal(r.particleTraffic.getRouteCount(), 0);
    assert.equal(r.namespacePlanes.size, 0);
});
