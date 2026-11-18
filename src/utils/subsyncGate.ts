/**
 * "One automatic sync at a time", page-wide.
 *
 * A sync can take minutes and owns shared, non-reentrant machinery: the single
 * ffmpeg.wasm instance and its one filesystem, and the worker's single active
 * run. A second request that started while the first was still going would
 * mount over its files, fold its audio into the wrong reference, and supersede
 * its worker run — leaving the first caller awaiting a reply that never comes.
 *
 * So the second request is refused up front, with `SubtitleSyncBusyError`, and
 * — crucially — the refusal happens BEFORE any of that shared state is touched.
 * A refused call therefore cannot cancel the active run's signal, clear the
 * decoder cache, or post anything to the worker. The `finally` only clears the
 * flag for the call that actually acquired it, so a refusal can never make the
 * active run look finished and let a third call slip in underneath it.
 *
 * Pure, tiny, and injectable (`createSyncGate`) so `node --test` covers the
 * ordering without a browser — see subsyncGate.test.ts.
 */

import { SubtitleSyncBusyError } from "./subsyncErrors.ts";

export interface SyncGate {
  /** True while a run owns the gate. */
  readonly busy: boolean;
  /**
   * Run `task` if nothing else is running. Rejects with `SubtitleSyncBusyError`
   * otherwise, without calling `task` and without disturbing whoever holds it.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export const createSyncGate = (): SyncGate => {
  let held = false;
  return {
    get busy() {
      return held;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (held) throw new SubtitleSyncBusyError();
      held = true;
      try {
        return await task();
      } finally {
        held = false;
      }
    },
  };
};

/** The gate every `syncSubtitles` call goes through. */
export const subtitleSyncGate = createSyncGate();
