import {
  applyError,
  applyResponse,
  beginRequest,
  createInitialInferenceState,
  isStale,
  resetState,
  type InferenceState,
} from "../web/ui/sharedstate/inferenceState.ts"
import type {
  InferenceResponse,
  OutputNode,
} from "../web/ui/types/bridge.types.ts"

function createOutputNodes(value = 0.05): OutputNode[] {
  return [
    {
      dimension: [1, 2, 2, 2],
      activationMaps: new Float32Array(8).fill(value),
    },
  ]
}

function createDefaultResponse(): InferenceResponse {
  return {
    action: "run",
    requestId: 0,
    isSuccessful: true,
    orderedOutputNodes: createOutputNodes(),
    predictions: new Float32Array(10).fill(0.1),
  }
}

function createResponse(requestId: number, marker: number): InferenceResponse {
  return {
    action: "run",
    requestId,
    isSuccessful: true,
    orderedOutputNodes: createOutputNodes(marker),
    predictions: new Float32Array(10).fill(marker),
  }
}

function newState(): InferenceState {
  return createInitialInferenceState(createDefaultResponse)
}

let failures = 0
let assertions = 0

function assert(condition: boolean, message: string) {
  assertions += 1
  if (!condition) {
    failures += 1
    console.error(`  FAIL: ${message}`)
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  // Float32Array elements are rounded, so numbers compare with a tolerance.
  const ok =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) < 1e-6
      : Object.is(actual, expected)
  assertions += 1
  if (!ok) {
    failures += 1
    console.error(`  FAIL: ${message} (expected ${String(expected)}, got ${String(actual)})`)
  }
}

function test(name: string, fn: () => void) {
  const before = failures
  fn()
  const status = failures === before ? "ok  " : "FAIL"
  console.log(`${status} ${name}`)
}

test("request ids increase monotonically", () => {
  const state = newState()
  assertEqual(beginRequest(state), 1, "first id")
  assertEqual(beginRequest(state), 2, "second id")
  assertEqual(state.latestRequestId, 2, "latest tracks last issued id")
})

test("only the newest request's response is applied", () => {
  const state = newState()
  const first = beginRequest(state)
  const second = beginRequest(state)

  // The late response for the first (older) drawing must be discarded.
  assertEqual(applyResponse(state, first, createResponse(first, 0.9)), false, "stale response rejected")
  assertEqual(state.response.predictions[0], 0.1, "stale response did not touch predictions")

  // The newest response is applied.
  assertEqual(applyResponse(state, second, createResponse(second, 0.7)), true, "current response accepted")
  assertEqual(state.response.predictions[0], 0.7, "current response is displayed")
  assertEqual(state.response.requestId, second, "request id recorded")

  // An even later arrival for the first request still cannot overwrite it.
  assertEqual(applyResponse(state, first, createResponse(first, 0.2)), false, "late stale response rejected")
  assertEqual(state.response.predictions[0], 0.7, "newest response preserved")
})

test("responses may arrive out of order and the newest still wins", () => {
  const state = newState()
  const first = beginRequest(state)
  const second = beginRequest(state)
  const third = beginRequest(state)

  assertEqual(applyResponse(state, third, createResponse(third, 0.3)), true, "newest accepted first")
  assertEqual(applyResponse(state, first, createResponse(first, 0.1)), false, "oldest rejected")
  assertEqual(applyResponse(state, second, createResponse(second, 0.2)), false, "middle rejected")
  assertEqual(state.response.predictions[0], 0.3, "newest response retained")
})

test("reset invalidates in-flight requests and restores defaults", () => {
  const state = newState()
  const inFlight = beginRequest(state)

  resetState(state, createDefaultResponse)

  assertEqual(state.response.predictions[0], 0.1, "predictions back to uniform")
  assertEqual(state.response.orderedOutputNodes[0].activationMaps[0], 0.05, "activation maps back to default")
  assertEqual(state.latestRequestId, inFlight, "reset does not fabricate a new request id")

  // The response for the request issued before the reset is now stale.
  assertEqual(applyResponse(state, inFlight, createResponse(inFlight, 0.99)), false, "pre-reset response rejected")
  assertEqual(state.response.predictions[0], 0.1, "defaults preserved after late response")
  assert(isStale(state, inFlight), "pre-reset request is stale")
})

test("reset gives the default response fresh buffers", () => {
  const state = newState()
  const firstResetResponse = state.response
  const before = firstResetResponse.orderedOutputNodes[0].activationMaps

  resetState(state, createDefaultResponse)

  assert(state.response !== firstResetResponse, "response object replaced")
  assert(state.response.orderedOutputNodes[0].activationMaps !== before, "buffers not shared with previous response")
})

test("a request issued after reset is accepted", () => {
  const state = newState()
  resetState(state, createDefaultResponse)
  const afterReset = beginRequest(state)
  assertEqual(applyResponse(state, afterReset, createResponse(afterReset, 0.42)), true, "post-reset request accepted")
  assertEqual(state.response.predictions[0], 0.42, "post-reset response displayed")
})

test("responses for ids that were never issued are rejected", () => {
  const state = newState()
  const first = beginRequest(state)

  // A bogus/future id must not be displayed even though it is not "older".
  assertEqual(applyResponse(state, 9999, createResponse(9999, 0.99)), false, "unissued id rejected")
  assertEqual(applyError(state, 9999, "bogus", createDefaultResponse), false, "unissued id failure ignored")
  assertEqual(state.response.predictions[0], 0.1, "defaults untouched")

  // The genuine newest request still works.
  assertEqual(applyResponse(state, first, createResponse(first, 0.5)), true, "issued id accepted")
})

test("request ids keep increasing after a reset", () => {
  const state = newState()
  const first = beginRequest(state)
  resetState(state, createDefaultResponse)
  const afterReset = beginRequest(state)

  assert(afterReset > first, "ids remain monotonic across reset")
  assertEqual(applyResponse(state, afterReset, createResponse(afterReset, 0.66)), true, "post-reset request accepted")
  assertEqual(state.response.predictions[0], 0.66, "post-reset response displayed")
})

test("a failed message never writes a partial response", () => {
  const state = newState()
  const request = beginRequest(state)
  const before = state.response

  const partial: InferenceResponse = {
    action: "run",
    requestId: request,
    isSuccessful: false,
    orderedOutputNodes: [],
    predictions: new Float32Array(0),
    error: "boom",
  }

  assertEqual(applyResponse(state, request, partial), false, "failed response rejected by completeness check")
  assert(state.response === before, "rendered inference state untouched")
  assertEqual(state.response.predictions[0], 0.1, "predictions stay at default")
  assertEqual(state.error, null, "a failed message is not silently recorded as success")
})

test("a current failure resets the display and is observable", () => {
  const state = newState()
  const request = beginRequest(state)
  assertEqual(applyResponse(state, request, createResponse(request, 0.8)), true, "good result applied")
  assertEqual(state.response.predictions[0], 0.8, "good result displayed")

  // The newest request failed: the previous request's result must not stay on
  // screen, because it does not correspond to the latest drawing.
  assertEqual(applyError(state, request, "boom", createDefaultResponse), true, "current failure recorded")
  assertEqual(state.error, "boom", "error observable")
  assertEqual(state.response.predictions[0], 0.1, "display restored to default")
  assertEqual(state.response.orderedOutputNodes[0].activationMaps[0], 0.05, "activation maps restored to default")
})

test("a stale failure cannot overwrite the newest failure", () => {
  const state = newState()
  const first = beginRequest(state)
  const second = beginRequest(state)

  assertEqual(applyError(state, second, "newest failed", createDefaultResponse), true, "newest failure recorded")
  assertEqual(applyError(state, first, "old failure", createDefaultResponse), false, "stale failure ignored")
  assertEqual(state.error, "newest failed", "newest error preserved")
})

test("successful response clears a previous error", () => {
  const state = newState()
  const request = beginRequest(state)
  applyError(state, request, "transient failure", createDefaultResponse)
  assertEqual(state.error, "transient failure", "error set")

  const next = beginRequest(state)
  assertEqual(state.error, null, "beginning a new request clears the error flag")
  applyResponse(state, next, createResponse(next, 0.5))
  assertEqual(state.error, null, "success leaves no error")
})

if (failures > 0) {
  console.error(`\n${failures} of ${assertions} assertions failed`)
  process.exit(1)
}

console.log(`\nAll ${assertions} assertions passed`)
