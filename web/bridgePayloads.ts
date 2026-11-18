import type { InferenceRequest } from "./ui/types/bridge.types.ts"

export type InferenceRequestFields = {
  requestId: number
  inputTensorData: Float32Array
  inputTensorDimension: number[]
  orderedOutputNodeNames: string[]
  finalNodeName: string
}

/**
 * Builds the payload for a `run` message.
 *
 * The worker takes ownership of the tensor buffer (it is posted as a
 * Transferable), so the payload must not alias the caller's array. Copying here
 * means the drawing loop can keep reusing its buffer on every tick, and two
 * in-flight requests can never share (and corrupt) the same memory.
 */
export function createInferenceRequestPayload({
  requestId,
  inputTensorData,
  inputTensorDimension,
  orderedOutputNodeNames,
  finalNodeName,
}: InferenceRequestFields): InferenceRequest {
  return {
    action: "run",
    requestId,
    inputTensorData: new Float32Array(inputTensorData),
    inputTensorDimension,
    orderedOutputNodeNames,
    finalNodeName,
  }
}

/** The buffers that must be transferred along with an inference request. */
export function getInferenceRequestTransferables(
  request: InferenceRequest,
): Transferable[] {
  return [request.inputTensorData.buffer]
}
