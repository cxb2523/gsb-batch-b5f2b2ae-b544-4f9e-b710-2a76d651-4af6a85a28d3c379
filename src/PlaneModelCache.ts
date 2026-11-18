import { PlaneModel } from "./PlaneModel";

/** A model which can release the GPU resources it owns. */
export interface DisposableModel {
    readonly isDisposed: boolean;
    dispose(gl: WebGLRenderingContext): void;
}

/** A body and glass model pair loaded for one plane preset. */
export interface PlaneModelPair<M extends DisposableModel = PlaneModel> {
    readonly body: M;
    readonly glass: M;
}

/** Loads one model of a plane preset. */
export type PlaneModelLoader<M extends DisposableModel> = (model: M, kind: "plane" | "glass") => Promise<void>;

interface PlaneModelEntry<M extends DisposableModel> {
    pair: PlaneModelPair<M>;
}

/**
 * Cache of plane models keyed by preset index.
 *
 * Models stay resident while their preset is the active one. When another
 * preset becomes active, `releaseAllExcept()` disposes every other cached
 * model, freeing its WebGL buffers; the cache entry itself is kept so the
 * preset is still known, and acquiring it again transparently reloads the
 * model. This bounds GPU memory to a single plane's models even after many
 * preset switches, while repeated switches still reuse a resident model.
 */
export class PlaneModelCache<M extends DisposableModel = PlaneModel> {
    private readonly entries = new Map<number, PlaneModelEntry<M>>();
    /** In-flight acquisitions, so concurrent requests for one preset share a load. */
    private readonly inFlight = new Map<number, Promise<PlaneModelPair<M>>>();

    /** @param createModel Factory for new, empty models (injectable for tests). */
    constructor(private readonly createModel: () => M = () => new PlaneModel() as unknown as M) {
    }

    /** Returns the resident (not disposed) model pair for the preset, if any. */
    getResident(preset: number): PlaneModelPair<M> | undefined {
        const entry = this.entries.get(preset);
        if (entry === undefined) {
            return undefined;
        }
        if (entry.pair.body.isDisposed || entry.pair.glass.isDisposed) {
            return undefined;
        }
        return entry.pair;
    }

    /** Whether the preset has a resident (not disposed) model pair. */
    hasResident(preset: number): boolean {
        return this.getResident(preset) !== undefined;
    }

    /**
     * Returns the preset's model pair, loading it when it is not resident.
     * A previously released preset is reloaded into fresh models.
     */
    acquire(gl: WebGLRenderingContext, preset: number, loader: PlaneModelLoader<M>): Promise<PlaneModelPair<M>> {
        const resident = this.getResident(preset);
        if (resident !== undefined) {
            return Promise.resolve(resident);
        }

        const pending = this.inFlight.get(preset);
        if (pending !== undefined) {
            return pending;
        }

        const body = this.createModel();
        const glass = this.createModel();
        const pair: PlaneModelPair<M> = { body, glass };

        const promise = Promise.all([loader(body, "plane"), loader(glass, "glass")])
            .then(() => {
                this.entries.set(preset, { pair });
                return pair;
            })
            .catch((error: unknown) => {
                // Do not leave half-loaded buffers around on failure.
                body.dispose(gl);
                glass.dispose(gl);
                this.entries.delete(preset);
                throw error;
            })
            .finally(() => {
                this.inFlight.delete(preset);
            });

        this.inFlight.set(preset, promise);
        return promise;
    }

    /**
     * Disposes the models of every preset except `keep`, releasing their GPU
     * buffers. Cache entries are retained so a later `acquire()` reloads them.
     */
    releaseAllExcept(gl: WebGLRenderingContext, keep: number): void {
        for (const [preset, entry] of Array.from(this.entries.entries())) {
            if (preset === keep) {
                continue;
            }
            entry.pair.body.dispose(gl);
            entry.pair.glass.dispose(gl);
        }
    }

    /** Disposes all cached models. */
    releaseAll(gl: WebGLRenderingContext): void {
        for (const entry of Array.from(this.entries.values())) {
            entry.pair.body.dispose(gl);
            entry.pair.glass.dispose(gl);
        }
    }

    /** Presets which currently keep their models resident (not disposed). */
    getResidentPresets(): number[] {
        return Array.from(this.entries.entries())
            .filter(([, entry]) => !entry.pair.body.isDisposed && !entry.pair.glass.isDisposed)
            .map(([preset]) => preset);
    }
}
