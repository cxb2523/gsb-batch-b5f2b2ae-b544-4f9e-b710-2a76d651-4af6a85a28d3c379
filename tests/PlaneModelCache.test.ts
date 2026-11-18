import { test } from "node:test";
import assert from "node:assert/strict";

import { PlaneModelCache, DisposableModel, PlaneModelPair } from "../src/PlaneModelCache";

/** A stand-in for PlaneModel which records dispose() calls without WebGL. */
class FakeModel implements DisposableModel {
    static live = 0;
    static created = 0;
    static disposeCalls = 0;

    disposed = false;
    loads = 0;

    constructor() {
        FakeModel.created++;
        FakeModel.live++;
    }

    get isDisposed(): boolean {
        return this.disposed;
    }

    dispose(_gl: WebGLRenderingContext): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        FakeModel.live--;
        FakeModel.disposeCalls++;
    }
}

const gl = {} as WebGLRenderingContext;

function createCache(): PlaneModelCache<FakeModel> {
    return new PlaneModelCache<FakeModel>(() => new FakeModel());
}

function loader(model: FakeModel, _kind: "plane" | "glass"): Promise<void> {
    model.loads++;
    return Promise.resolve();
}

async function acquire(cache: PlaneModelCache<FakeModel>, preset: number): Promise<PlaneModelPair<FakeModel>> {
    return cache.acquire(gl, preset, loader);
}

test("acquiring a preset loads it once and reuses it", async () => {
    FakeModel.created = 0;
    const cache = createCache();

    const first = await acquire(cache, 0);
    const second = await acquire(cache, 0);

    assert.equal(first, second);
    assert.equal(FakeModel.created, 2, "one body and one glass model");
    assert.equal(cache.hasResident(0), true);
});

test("releasing disposes every preset except the active one", async () => {
    FakeModel.disposeCalls = 0;
    const cache = createCache();

    const p0 = await acquire(cache, 0);
    const p1 = await acquire(cache, 1);
    assert.equal(cache.getResidentPresets().length, 2);

    cache.releaseAllExcept(gl, 1);

    assert.equal(p0.body.isDisposed, true);
    assert.equal(p0.glass.isDisposed, true);
    assert.equal(p1.body.isDisposed, false);
    assert.equal(p1.glass.isDisposed, false);
    assert.deepEqual(cache.getResidentPresets(), [1]);
});

test("a released preset is reloaded into fresh, working models", async () => {
    FakeModel.created = 0;
    const cache = createCache();

    const original = await acquire(cache, 0);
    cache.releaseAllExcept(gl, 1);

    // Switch back: the cache must not hand out the disposed models.
    const reloaded = await acquire(cache, 0);

    assert.notEqual(reloaded, original);
    assert.notEqual(reloaded.body, original.body);
    assert.equal(reloaded.body.isDisposed, false);
    assert.equal(reloaded.glass.isDisposed, false);
    assert.equal(reloaded.body.loads, 1);
    assert.equal(cache.hasResident(0), true);
});

test("repeated switches do not accumulate live models", async () => {
    FakeModel.live = 0;
    const cache = createCache();

    let active = 0;
    await acquire(cache, active);

    for (let i = 0; i < 20; i++) {
        const next = (active + 1) % 5;
        await acquire(cache, next);
        cache.releaseAllExcept(gl, next);
        active = next;

        // Only the active preset's two models may stay alive.
        assert.equal(FakeModel.live, 2, `after switch ${i}, only the active preset may be resident`);
    }
});

test("concurrent acquisitions of a preset share a single load", async () => {
    FakeModel.created = 0;
    const cache = createCache();

    const [a, b] = await Promise.all([acquire(cache, 2), acquire(cache, 2)]);

    assert.equal(a, b);
    assert.equal(FakeModel.created, 2, "duplicate in-flight loads must not allocate extra models");
});

test("a failed load disposes the partially loaded models", async () => {
    FakeModel.disposeCalls = 0;
    FakeModel.live = 0;
    const cache = createCache();

    await assert.rejects(
        cache.acquire(gl, 3, (model, kind) => {
            if (kind === "glass") {
                return Promise.reject(new Error("network failure"));
            }
            return Promise.resolve();
        })
    );

    assert.equal(cache.hasResident(3), false);
    assert.equal(FakeModel.live, 0, "half-loaded models must be disposed on failure");
});
