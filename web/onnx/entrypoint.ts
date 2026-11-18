import type {
  InferenceRequest,
  InferenceResponse,
  InitializationRequest,
  InitializationResponse,
  OutputNode,
} from "@ui/types/bridge.types"
import { createModel, runModel, warmupModel } from "onnx/runmodel"
import { Tensor, type InferenceSession } from "onnxruntime-web"

let model: InferenceSession | undefined

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

onmessage = async (
  event: MessageEvent<InitializationRequest | InferenceRequest>,
) => {
  if (event.data.action == "initialize") {
    let request = event.data
    let response: InitializationResponse = {
      action: "initialize",
      isSuccessful: false,
    }
    try {
      model = await createModel(request.modelURL)
      // No need to await warmup, it is only a performance improvement — but
      // observe its failure instead of leaving an unhandled rejection.
      warmupModel(model, request.inputTensorDimension).catch((error) => {
        console.warn("Model warmup failed (inference still available)", error)
      })
      response.isSuccessful = true
    } catch (error) {
      response.error = describeError(error)
      model = undefined
      console.error("Error INITIALIZING model", error)
    } finally {
      postMessage(response)
    }
  } else {
    let request = event.data
    let response: InferenceResponse = {
      action: "run",
      requestId: request.requestId,
      isSuccessful: false,
      orderedOutputNodes: [],
      predictions: new Float32Array(),
    }
    /*
      Transfering buffers instead of an expensive serialized copy
      https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
     */
    const transfer: Transferable[] = []
    try {
      if (!model) {
        throw new Error("model has not been initialized")
      }

      const inputTensor = new Tensor(
        "float32",
        request.inputTensorData,
        request.inputTensorDimension,
      )
      const inferenceResult = await runModel(model, inputTensor)

      const predictions = inferenceResult[request.finalNodeName]?.data
      if (!(predictions instanceof Float32Array)) {
        throw new Error(
          `model output "${request.finalNodeName}" is missing or malformed`,
        )
      }

      // Loading activation maps
      const orderedOutputNodes: OutputNode[] = []
      for (const nodeName of request.orderedOutputNodeNames) {
        const tensor = inferenceResult[nodeName]

        if (!(tensor?.data instanceof Float32Array)) {
          throw new Error(
            `model output "${nodeName}" is missing or malformed`,
          )
        }

        orderedOutputNodes.push({
          dimension: tensor.dims,
          activationMaps: tensor.data,
        })
      }

      // Only publish a complete response; a failure above leaves the default
      // state untouched on the main thread.
      response.isSuccessful = true
      response.predictions = predictions
      response.orderedOutputNodes = orderedOutputNodes

      // Transfer each activation map (zero-copy) exactly once. A Set guards
      // against DataCloneError if two outputs ever alias the same buffer.
      // Predictions are small and are structured-cloned instead, so that the
      // model's output buffer is never detached.
      const transferableBuffers = new Set<ArrayBuffer>()
      for (const node of orderedOutputNodes) {
        transferableBuffers.add(node.activationMaps.buffer)
      }
      transfer.push(...transferableBuffers)
    } catch (error) {
      response.isSuccessful = false
      response.error = describeError(error)
      response.orderedOutputNodes = []
      response.predictions = new Float32Array()
      transfer.length = 0
      console.error("Error while RUNNING model", error)
    } finally {
      postMessage(response, { transfer })
    }
  }
}
