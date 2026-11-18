/** Base class for every error thrown by `seslen`. Use `instanceof` to gate
 *  recovery paths. */
export class SeslenError extends Error {
  override name = "SeslenError"
}

/** Thrown when the AudioContext is unavailable — typically because the
 *  caller is on a non-browser runtime. */
export class ContextNotReadyError extends SeslenError {
  override name = "ContextNotReadyError"
}

/** Thrown when a `play()` / `preload()` is cancelled because `close()` was
 * called while its URL fetch/decode was still in flight. The call never
 * starts a voice on the closed context — catch this (or `SeslenError`) to
 * distinguish cancellation from ordinary load/decode failures. */
export class ContextClosedError extends SeslenError {
  override name = "ContextClosedError"
}

/** Thrown when `decodeAudioData` rejects (corrupt or unsupported format). */
export class DecodeError extends SeslenError {
  override name = "DecodeError"
}

/** Thrown when the underlying `fetch` for a sound fails. */
export class LoadError extends SeslenError {
  override name = "LoadError"
}
