// Communication bridge between webworkers => resoponsive UI with asynchronous updates
//
// Message types live in `ui/types/bridge.types` (types-only, worker-safe) and
// are re-exported here for backwards compatibility with existing imports.

import {
  applyInferenceResponse,
  beginInferenceRequest,
  reportInferenceError,
} from "@sharedstate/inference.svelte"
import {
  createInferenceRequestPayload,
  getInferenceRequestTransferables,
} from "bridgePayloads"
import { onnxRuntime } from "main"
import type {
  InferenceResponse,
  InitializationRequest,
  InitializationResponse,
} from "@ui/types/bridge.types"

export type {
  InferenceRequest,
  InferenceResponse,
  InitializationRequest,
  InitializationResponse,
  OutputNode,
} from "@ui/types/bridge.types"

function registerDefaultEventListener() {
  onnxRuntime.addEventListener(
    "message",
    (event: MessageEvent<InferenceResponse>) => {
      const response = event.data

      // Initialization handshakes are handled by initializeRuntime and should
      // never reach this listener.
      if (response.action !== "run") {
        return
      }

      if (!response.isSuccessful) {
        const message =
          response.error ?? "unknown error while running the model"
        console.error(
          `Inference request #${response.requestId} failed: ${message}`,
        )
        // Do not write a partial response into the shared state.
        reportInferenceError(response.requestId, message)
        return
      }

      // Responses older than the latest request are discarded by shared state.
      applyInferenceResponse(response.requestId, response)
    },
  )
}

export function initializeRuntime(
  modelURL: string,
  inputTensorDimension: number[],
): Promise<InitializationResponse> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<InitializationResponse>) => {
      if (event.data.action !== "initialize") {
        return
      }

      onnxRuntime.removeEventListener("message", handler)

      if (event.data.isSuccessful) {
        registerDefaultEventListener()
        resolve(event.data)
      } else {
        const message =
          event.data.error ?? "unknown error while initializing the model"
        console.error(`Failed to initialize runtime: ${message}`)
        reject(new Error(message))
      }
    }

    onnxRuntime.addEventListener("message", handler)

    const message: InitializationRequest = {
      action: "initialize",
      modelURL,
      inputTensorDimension,
    }

    onnxRuntime.postMessage(message)
  })
}

/**
 * Queues an inference request and returns its request id.
 *
 * The input buffer is transferred to the worker (zero-copy), which means the
 * caller loses ownership of the array it passes in. We therefore send a private
 * copy so callers can keep reusing their own buffer, and so that no two
 * requests ever share/corrupt the same memory.
 */
export function runModel(
  inputTensorData: Float32Array,
  inputTensorDimension: Array<number>,
  orderedOutputNodeNames: string[],
  finalNodeName: string,
): number {
  const requestId = beginInferenceRequest()

  const message = createInferenceRequestPayload({
    requestId,
    inputTensorData,
    inputTensorDimension,
    orderedOutputNodeNames,
    finalNodeName,
  })

  onnxRuntime.postMessage(message, {
    transfer: getInferenceRequestTransferables(message),
  })

  return requestId
}
