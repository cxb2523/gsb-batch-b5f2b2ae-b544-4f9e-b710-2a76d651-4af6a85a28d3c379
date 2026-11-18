/**
 * Errors that are about a sync RUN rather than about its result.
 *
 * They live in their own module with no imports so both the engine layer and
 * the audio layer can throw the SAME class without either pulling the other
 * (or the browser-only audio machinery) into its bundle or its tests.
 */

/**
 * Raised when a sync is asked to start while another one is still running.
 *
 * Deliberately NOT an AbortError and deliberately not a generic failure: the
 * caller did nothing wrong, the request was simply refused, and the run that
 * already owns the decoder/worker must be left completely untouched. The
 * rejected call therefore never clears the decoder cache, never aborts the
 * active run's signal and never posts a cancel to its worker.
 */
export class SubtitleSyncBusyError extends Error {
  constructor(message = "A subtitle sync is already running. Cancel it before starting another.") {
    super(message);
    this.name = "SubtitleSyncBusyError";
  }
}
