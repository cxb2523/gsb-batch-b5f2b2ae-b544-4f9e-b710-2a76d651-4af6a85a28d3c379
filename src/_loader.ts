/// <reference path="./env.d.ts" />
import { ContextClosedError, DecodeError, LoadError } from "./errors.ts"

/** Fetch a URL and decode it into an AudioBuffer.
 *
 * Pass the owning context's `AbortSignal`: `close()` aborts every in-flight
 * load so a teardown cannot leave a dangling network request. An aborted
 * load rejects with `ContextClosedError` rather than a plain `LoadError` so
 * callers can distinguish lifecycle cancellation from real failures. */
export async function fetchAndDecode(
  ctx: AudioContext,
  url: string,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  let res
  try {
    res = await fetch(url, signal ? { signal } : undefined)
  } catch (cause) {
    if (signal?.aborted) {
      throw new ContextClosedError(`seslen: load of ${url} cancelled by close()`, { cause })
    }
    throw new LoadError(`seslen: failed to fetch ${url}`, { cause })
  }
  if (!res.ok) throw new LoadError(`seslen: failed to fetch ${url}`)
  const bytes = await res.arrayBuffer()
  try {
    return await ctx.decodeAudioData(bytes)
  } catch (cause) {
    if (signal?.aborted) {
      throw new ContextClosedError(`seslen: decode of ${url} cancelled by close()`, { cause })
    }
    throw new DecodeError(`seslen: failed to decode ${url}`, { cause })
  }
}
