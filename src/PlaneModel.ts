import { FullModel } from "webgl-framework";

/**
 * A plane model which can release the WebGL buffers it owns.
 *
 * `FullModel` from the framework has no way to free its buffers, so every
 * model loaded for a plane preset would keep its GPU memory for the lifetime
 * of the page. Disposing models which are no longer needed keeps memory usage
 * bounded when the user switches between planes repeatedly.
 *
 * Live/created buffer counters are tracked so that automated browser checks
 * (and the debug UI hook) can observe that released models actually free GPU
 * resources and that reloading a previously used preset allocates them again.
 */
export class PlaneModel extends FullModel {
    /** Number of WebGL buffers currently alive for all plane models. */
    private static liveBuffers = 0;
    /** Number of WebGL buffers created for all plane models since page load. */
    private static createdBuffers = 0;

    private disposed = false;
    /** Number of buffers this model currently owns. */
    private ownedBuffers = 0;

    /** Whether the underlying WebGL buffers have already been deleted. */
    get isDisposed(): boolean {
        return this.disposed;
    }

    static getLiveBufferCount(): number {
        return PlaneModel.liveBuffers;
    }

    static getCreatedBufferCount(): number {
        return PlaneModel.createdBuffers;
    }

    /** @inheritdoc */
    async load(url: string, gl: WebGLRenderingContext): Promise<void> {
        if (this.disposed) {
            throw new Error(`Cannot load a disposed plane model: ${url}`);
        }

        await super.load(url, gl);

        // FullModel.load() allocates one index buffer and one strides buffer.
        this.ownedBuffers = 2;
        PlaneModel.liveBuffers += 2;
        PlaneModel.createdBuffers += 2;
    }

    /**
     * Deletes the model's WebGL buffers. Safe to call more than once and on a
     * model which has not finished (or never started) loading.
     */
    dispose(gl: WebGLRenderingContext): void {
        if (this.disposed) {
            return;
        }

        const indices = this.bufferIndices as WebGLBuffer | null | undefined;
        const strides = this.bufferStrides as WebGLBuffer | null | undefined;

        if (indices) {
            gl.deleteBuffer(indices);
        }
        if (strides) {
            gl.deleteBuffer(strides);
        }

        PlaneModel.liveBuffers -= this.ownedBuffers;
        this.ownedBuffers = 0;

        this.bufferIndices = null;
        this.bufferStrides = null;
        this.disposed = true;
    }
}
