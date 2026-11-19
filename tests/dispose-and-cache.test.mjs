// 场景三：dispose 与重复 start/stop 不得残留动画帧或事件监听；
// 标签纹理共享缓存不得误删、也不得无限增长。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRendererHarness,
    makeState,
    makeResource,
    pendingFrameCount,
    flushPendingFrames,
    findLabelTexture,
} from './helpers.mjs';
import {
    ResourceMeshFactory,
    getLabelTextureCacheSize,
    disposeLabelTextureCache,
} from '../js/rendering/ResourceMeshes.js';

test('重复 start/stop 不残留动画帧', () => {
    const r = createRendererHarness();
    const before = pendingFrameCount();

    r.start();
    r.start(); // 重复 start 不应叠加动画循环
    assert.equal(pendingFrameCount() - before, 1);

    flushPendingFrames(); // 执行一帧 → 重新调度下一帧
    assert.equal(pendingFrameCount() - before, 1);

    r.stop();
    assert.equal(pendingFrameCount() - before, 0);
    assert.equal(r.running, false);

    // 再次 start/stop 依然干净
    r.start();
    assert.equal(pendingFrameCount() - before, 1);
    r.stop();
    r.stop(); // 重复 stop 安全
    assert.equal(pendingFrameCount() - before, 0);
});

test('animateToPositions 的补间动画帧在 stop 后被取消', () => {
    const r = createRendererHarness();
    r.syncWithState(makeState({
        resources: [makeResource('a', 'Pod', 'p', 'default')],
    }));

    const before = pendingFrameCount();
    r.animateToPositions(new Map([['a', { x: 5, y: 0, z: 5 }]]), 800);
    assert.equal(pendingFrameCount() - before, 1);

    r.stop();
    assert.equal(pendingFrameCount() - before, 0);
});

test('重复 dispose 幂等：无残留帧、事件监听只解绑一次、子系统只销毁一次', () => {
    const r = createRendererHarness();
    r.syncWithState(makeState({
        resources: [
            makeResource('a', 'Pod', 'p1', 'apps', 0, 0),
            makeResource('b', 'Service', 's1', 'apps', 3, 0),
        ],
        connections: [{ id: 'c1', sourceId: 'a', targetId: 'b', type: 'network' }],
        trafficRoutes: [{
            id: 'r1', sourceId: 'a', targetId: 'b',
            sourcePos: { x: 0, y: 0, z: 0 }, targetPos: { x: 3, y: 0, z: 0 },
        }],
    }));

    r.start();
    const before = pendingFrameCount();
    assert.ok(before > 0);

    r.dispose();

    assert.equal(r._disposed, true);
    assert.equal(r.running, false);
    assert.equal(pendingFrameCount(), 0, 'dispose 后不得残留动画帧');

    // canvas 上的事件监听全部被解绑
    assert.deepEqual(
        [...r.canvas.removedListeners].sort(),
        ['contextmenu', 'mousedown', 'mousemove', 'mouseup']
    );
    // window 的 resize 监听被解绑
    assert.deepEqual(globalThis.window.removedListeners, ['resize']);

    // 子系统销毁
    assert.equal(r.controls.disposeCount, 1);
    assert.equal(r.renderer.disposeCount, 1);
    assert.equal(r.resourceMeshes.size, 0);
    assert.equal(r.connectionLines.getConnectionCount(), 0);
    assert.equal(r.particleTraffic.getRouteCount(), 0);
    assert.equal(r.namespacePlanes.size, 0);

    // dispose 后 start 是 no-op
    r.start();
    assert.equal(r.running, false);
    assert.equal(pendingFrameCount(), 0);

    // 重复 dispose 不抛错、不重复清理
    const canvasRemovals = r.canvas.removedListeners.length;
    assert.doesNotThrow(() => r.dispose());
    assert.equal(r.renderer.disposeCount, 1);
    assert.equal(r.controls.disposeCount, 1);
    assert.equal(r.canvas.removedListeners.length, canvasRemovals);
    assert.equal(globalThis.window.removedListeners.length, 1);
});

test('共享标签纹理：移除一个资源不会误删其他资源在用的纹理', () => {
    disposeLabelTextureCache();
    const factory = new ResourceMeshFactory();

    const g1 = factory.create({ type: 'Pod', name: 'shared-name', status: 'Running' });
    const g2 = factory.create({ type: 'Pod', name: 'shared-name', status: 'Running' });

    const t1 = findLabelTexture(g1);
    const t2 = findLabelTexture(g2);
    assert.ok(t1);
    assert.equal(t1, t2, '同名标签应共享同一纹理');

    let disposed = false;
    t1.addEventListener('dispose', () => { disposed = true; });

    factory.dispose(g1);
    assert.equal(disposed, false, '仍有其他标签在使用，纹理不得销毁');
    assert.equal(findLabelTexture(g2), t1, 'g2 的标签纹理仍然有效');

    factory.dispose(g2);
    assert.equal(disposed, false, '引用归零后纹理保留在缓存中备用，不立即销毁');

    disposeLabelTextureCache();
});

test('标签纹理缓存有上限，不无限增长', () => {
    disposeLabelTextureCache();
    const factory = new ResourceMeshFactory();

    // 持续创建并销毁不同名字的资源：引用归零的纹理应被 LRU 淘汰
    for (let i = 0; i < 300; i++) {
        const g = factory.create({ type: 'Pod', name: `pod-${i}`, status: 'Running' });
        factory.dispose(g);
    }
    assert.ok(
        getLabelTextureCacheSize() <= 128,
        `缓存大小 ${getLabelTextureCacheSize()} 应不超过上限 128`
    );

    // 最早创建的纹理应已被淘汰并销毁
    const victim = factory.create({ type: 'Pod', name: 'evict-me', status: 'Running' });
    const victimTexture = findLabelTexture(victim);
    let victimDisposed = false;
    victimTexture.addEventListener('dispose', () => { victimDisposed = true; });
    factory.dispose(victim);

    for (let i = 0; i < 300; i++) {
        const g = factory.create({ type: 'Pod', name: `filler-${i}`, status: 'Running' });
        factory.dispose(g);
    }
    assert.equal(victimDisposed, true, '被淘汰的缓存纹理应被销毁');

    disposeLabelTextureCache();
});
