import { createDefaultInferenceResponse } from "@constants/mnist"
import type { InferenceResponse } from "../types/bridge.types"
import {
  applyError,
  applyResponse,
  beginRequest,
  createInitialInferenceState,
  resetState,
} from "./inferenceState"

/**
 * Ordering/validation rules live in `inferenceState.ts`; this module only wires
 * them to Svelte reactivity. The runes below mirror the pure state so that
 * components re-render when a response is accepted or the canvas is reset.
 */
const state = createInitialInferenceState(createDefaultInferenceResponse)

let inferenceResponse = $state<InferenceResponse>(state.response)
let inferenceError = $state<string | null>(state.error)

export function getInferenceResponse() {
  return inferenceResponse
}

export function getInferenceError() {
  return inferenceError
}

/**
 * Allocate the id for a newly issued inference request. Any response that is
 * still in flight for an older id becomes stale from this point on.
 */
export function beginInferenceRequest(): number {
  const requestId = beginRequest(state)
  inferenceError = state.error
  return requestId
}

/** Latest request id, exposed for diagnostics and tests. */
export function getLatestInferenceRequestId(): number {
  return state.latestRequestId
}

/**
 * Commit a worker response to the shared state, but only when it belongs to
 * the newest request and is complete. Returns whether it was accepted.
 */
export function applyInferenceResponse(
  requestId: number,
  response: InferenceResponse,
): boolean {
  if (!applyResponse(state, requestId, response)) {
    return false
  }

  inferenceResponse = state.response
  inferenceError = state.error
  return true
}

/**
 * Record a failure for the newest request. The displayed activation maps and
 * predictions return to their defaults (the latest drawing has no valid
 * result), while the error remains observable through `getInferenceError()`.
 * Stale failures are dropped just like stale successes.
 */
export function reportInferenceError(
  requestId: number,
  message: string,
): boolean {
  if (
    !applyError(
      state,
      requestId,
      message,
      createDefaultInferenceResponse,
    )
  ) {
    return false
  }

  inferenceResponse = state.response
  inferenceError = state.error
  return true
}

/**
 * Invalidate every request that is still in flight and restore the default
 * activation / prediction state immediately.
 */
export function resetInference() {
  resetState(state, createDefaultInferenceResponse)
  inferenceResponse = state.response
  inferenceError = state.error
}
