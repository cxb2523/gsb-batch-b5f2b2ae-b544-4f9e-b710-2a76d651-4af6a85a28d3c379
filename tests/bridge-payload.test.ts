import {
  createInferenceRequestPayload,
  getInferenceRequestTransferables,
} from "../web/bridgePayloads.ts"

let failures = 0
let assertions = 0

function assert(condition: boolean, message: string) {
  assertions += 1
  if (!condition) {
    failures += 1
    console.error(`  FAIL: ${message}`)
  }
}

function test(name: string, fn: () => void) {
  const before = failures
  fn()
  console.log(`${failures === before ? "ok  " : "FAIL"} ${name}`)
}

test("payload does not alias the caller's buffer", () => {
  const callerBuffer = new Float32Array([0.1, 0.2, 0.3, 0.4])

  const request = createInferenceRequestPayload({
    requestId: 1,
    inputTensorData: callerBuffer,
    inputTensorDimension: [1, 1, 2, 2],
    orderedOutputNodeNames: [],
    finalNodeName: "output",
  })

  assert(
    request.inputTensorData.buffer !== callerBuffer.buffer,
    "payload owns a distinct ArrayBuffer",
  )
  assert(
    request.inputTensorData[0] === callerBuffer[0],
    "payload content matches the caller's data",
  )
  assert(request.requestId === 1, "request id carried through")
  assert(request.action === "run", "action is run")
})

test("caller can keep reusing its buffer after sending", () => {
  const callerBuffer = new Float32Array([1, 1, 1, 1])

  const first = createInferenceRequestPayload({
    requestId: 1,
    inputTensorData: callerBuffer,
    inputTensorDimension: [1, 1, 2, 2],
    orderedOutputNodeNames: [],
    finalNodeName: "output",
  })

  // Simulate the structured clone / transfer that posts the message.
  structuredClone(first.inputTensorData, {
    transfer: getInferenceRequestTransferables(first),
  })

  // The payload's buffer is detached by the transfer...
  assert(
    first.inputTensorData.buffer.byteLength === 0,
    "payload buffer is detached by transfer",
  )
  // ...but the caller's buffer is still usable.
  callerBuffer.fill(0.5)
  assert(callerBuffer[0] === 0.5, "caller buffer still writable")
  assert(callerBuffer.byteLength === 16, "caller buffer not detached")

  const second = createInferenceRequestPayload({
    requestId: 2,
    inputTensorData: callerBuffer,
    inputTensorDimension: [1, 1, 2, 2],
    orderedOutputNodeNames: [],
    finalNodeName: "output",
  })
  assert(second.inputTensorData[0] === 0.5, "second request sees current data")
  assert(
    second.inputTensorData.buffer !== callerBuffer.buffer,
    "second request also owns its buffer",
  )
})

test("two in-flight requests never share a buffer", () => {
  const callerBuffer = new Float32Array([0, 0, 0, 0])

  const first = createInferenceRequestPayload({
    requestId: 1,
    inputTensorData: callerBuffer,
    inputTensorDimension: [1, 1, 2, 2],
    orderedOutputNodeNames: [],
    finalNodeName: "output",
  })
  const second = createInferenceRequestPayload({
    requestId: 2,
    inputTensorData: callerBuffer,
    inputTensorDimension: [1, 1, 2, 2],
    orderedOutputNodeNames: [],
    finalNodeName: "output",
  })

  assert(
    first.inputTensorData.buffer !== second.inputTensorData.buffer,
    "requests have independent buffers",
  )

  first.inputTensorData[0] = 9
  assert(second.inputTensorData[0] !== 9, "mutating one does not affect the other")
})

if (failures > 0) {
  console.error(`\n${failures} of ${assertions} assertions failed`)
  process.exit(1)
}

console.log(`\nAll ${assertions} assertions passed`)
