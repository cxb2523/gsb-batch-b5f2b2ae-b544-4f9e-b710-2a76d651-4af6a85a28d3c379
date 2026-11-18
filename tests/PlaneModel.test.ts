import { test } from "node:test";
import assert from "node:assert/strict";

import { PlaneModel } from "../src/PlaneModel";

/**
 * Minimal WebGL stub recording deleted buffers. PlaneModel only touches
 * deleteBuffer() in dispose(), so no real context is needed.
 */
function createGlStub(): { gl: WebGLRenderingContext; deleted: unknown[] } {
    const deleted: unknown[] = [];
    const gl = {
        deleteBuffer: (buffer: unknown) => deleted.push(buffer)
    } as unknown as WebGLRenderingContext;
    return { gl, deleted };
}

/** Simulates the buffers FullModel.load() would have allocated. */
function attachBuffers(model: PlaneModel, indices: object, strides: object): void {
    const writable = model as unknown as { bufferIndices: object; bufferStrides: object };
    writable.bufferIndices = indices;
    writable.bufferStrides = strides;
}

test("dispose deletes both WebGL buffers", () => {
    const { gl, deleted } = createGlStub();
    const model = new PlaneModel();
    const indices = { name: "indices" };
    const strides = { name: "strides" };
    attachBuffers(model, indices, strides);

    model.dispose(gl);

    assert.deepEqual(deleted, [indices, strides]);
    assert.equal(model.isDisposed, true);
});

test("dispose is idempotent and never deletes buffers twice", () => {
    const { gl, deleted } = createGlStub();
    const model = new PlaneModel();
    attachBuffers(model, { name: "indices" }, { name: "strides" });

    model.dispose(gl);
    model.dispose(gl);
    model.dispose(gl);

    assert.equal(deleted.length, 2);
});

test("dispose on a model which never loaded is safe", () => {
    const { gl, deleted } = createGlStub();
    const model = new PlaneModel();

    model.dispose(gl);

    assert.deepEqual(deleted, []);
    assert.equal(model.isDisposed, true);
});

test("a disposed model cannot be reloaded", async () => {
    const { gl } = createGlStub();
    const model = new PlaneModel();
    model.dispose(gl);

    await assert.rejects(model.load("data/models/01-plane", gl), /disposed/);
});
