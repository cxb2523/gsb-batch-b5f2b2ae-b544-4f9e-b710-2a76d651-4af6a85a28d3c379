import type { InferenceResponse } from "../types/bridge.types"

/**
 * Pure (Svelte-free, DOM-free) state machine for inference results.
 *
 * Keeping the ordering rules here lets the "stale response" behaviour be tested
 * with a plain Node test runner, independent of the worker and the UI. The
 * default response factory is injected rather than imported so this module has
 * no runtime dependencies at all.
 */

export type InferenceState = {
  /** The response currently rendered by the UI. */
  response: InferenceResponse
  /** Last inference failure, or `null` when the last request succeeded. */
  error: string | null
  /** Id of the newest inference request issued so far. */
  latestRequestId: number
  /**
   * Every request with an id at or below this value has been invalidated (by a
   * canvas reset). Kept separate from `latestRequestId` so that invalidating
   * in-flight work never pretends a new request was issued.
   */
  invalidatedThrough: number
}

export function createInitialInferenceState(
  createDefaultResponse: () => InferenceResponse,
): InferenceState {
  return {
    response: createDefaultResponse(),
    error: null,
    latestRequestId: 0,
    invalidatedThrough: 0,
  }
}

/**
 * Allocate the id of a newly issued request. Every response that is still in
 * flight for an older id becomes stale from this point on.
 */
export function beginRequest(state: InferenceState): number {
  state.latestRequestId += 1
  state.error = null
  return state.latestRequestId
}

export function isStale(state: InferenceState, requestId: number): boolean {
  return (
    requestId <= state.invalidatedThrough ||
    requestId < state.latestRequestId
  )
}

/**
 * Only the response for the newest request, which has not been invalidated, may
 * be displayed. Ids the main thread never handed out are rejected too.
 */
export function isCurrent(state: InferenceState, requestId: number): boolean {
  return requestId === state.latestRequestId && !isStale(state, requestId)
}

function isCompleteResponse(response: InferenceResponse): boolean {
  return (
    response.isSuccessful === true &&
    Array.isArray(response.orderedOutputNodes) &&
    response.orderedOutputNodes.every(
      (node) =>
        node != null &&
        Array.isArray(node.dimension) &&
        node.activationMaps instanceof Float32Array,
    ) &&
    response.predictions instanceof Float32Array
  )
}

/**
 * Commit a worker response, but only when it belongs to the newest request and
 * is structurally complete. Returns whether the response was accepted.
 */
export function applyResponse(
  state: InferenceState,
  requestId: number,
  response: InferenceResponse,
): boolean {
  if (!isCurrent(state, requestId) || !isCompleteResponse(response)) {
    return false
  }

  state.response = { ...response, requestId }
  state.error = null
  return true
}

/**
 * Record a failure for the newest request.
 *
 * The rendered result is restored to the default state: the latest drawing has
 * no valid result, and keeping the previous request's output would display a
 * result that does not correspond to the most recent drawing. Responses that
 * fail are never partially written, only recorded through `error`.
 * Failures from superseded or invalidated requests are ignored.
 */
export function applyError(
  state: InferenceState,
  requestId: number,
  message: string,
  createDefaultResponse: () => InferenceResponse,
): boolean {
  if (!isCurrent(state, requestId)) {
    return false
  }

  state.response = createDefaultResponse()
  state.error = message
  return true
}

/**
 * Invalidate every in-flight request and restore the default response.
 *
 * Raising `invalidatedThrough` to the newest issued id is what makes late
 * responses stale: they fail the `isCurrent` check and can never repopulate the
 * shared state.
 */
export function resetState(
  state: InferenceState,
  createDefaultResponse: () => InferenceResponse,
): number {
  state.invalidatedThrough = Math.max(
    state.invalidatedThrough,
    state.latestRequestId,
  )
  state.response = createDefaultResponse()
  state.error = null
  return state.invalidatedThrough
}
