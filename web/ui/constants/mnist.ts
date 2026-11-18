import { TENSOR_DEFAULT_GRAY_VALUE } from "./graphics"
import type { InferenceResponse, OutputNode } from "../types/bridge.types"

export const MODEL_URL = "/mnist-12.onnx"
export const INPUT_TENSOR_DIMENSION = [1, 1, 28, 28]
export const ORDERED_NODE_NAMES = [
  "Visual_ReLU32_Output_0",
  "Visual_Pooling66_Output_0",
  "Visual_ReLU114_Output_0",
  "Visual_Pooling160_Output_0",
]
export const FINAL_NODE = "Softmax_Output_0"
const ORDERED_NODE_DIMENSIONS = [
  [1, 8, 28, 28],
  [1, 8, 14, 14],
  [1, 16, 14, 14],
  [1, 16, 4, 4],
]

/**
 * Builds a fresh default inference response.
 *
 * A factory (rather than a shared object) is used whenever the UI is reset so
 * that a cleared canvas never aliases buffers that a previous response (or a
 * consumer) could still be holding on to.
 */
export function createDefaultInferenceResponse(): InferenceResponse {
  const orderedOutputNodes: OutputNode[] = []

  for (let i = 0; i < ORDERED_NODE_NAMES.length; i += 1) {
    const tensorDimension = ORDERED_NODE_DIMENSIONS[i]
    const activationMapLength =
      tensorDimension[1] * tensorDimension[2] * tensorDimension[3]

    orderedOutputNodes.push({
      dimension: tensorDimension,
      activationMaps: new Float32Array(activationMapLength).fill(
        TENSOR_DEFAULT_GRAY_VALUE,
      ),
    })
  }

  return {
    action: "run",
    isSuccessful: true,
    requestId: 0,
    orderedOutputNodes,
    predictions: new Float32Array(10).fill(0.1), // Probability of 1 distributed equally among 10 possibilities
  }
}

export const ACTIVATION_MAPS_DEFAULT_VALUE: InferenceResponse =
  createDefaultInferenceResponse()

export const INPUT_TENSOR_DEFAULT_VALUE = (() => {
  const newTensor = new Float32Array(
    INPUT_TENSOR_DIMENSION.reduce((a, b) => a * b),
  )
  newTensor.fill(TENSOR_DEFAULT_GRAY_VALUE)
  return newTensor
})()

export type LayerName =
  | ""
  | "Input"
  | "Convolution Layer #1"
  | "Max Pool #1"
  | "Convolution Layer #2"
  | "Max Pool #2"

type Kernel = {
  stride: number
  dimension: number
  tick: number
}

export const KERNEL_INFO: Partial<Record<LayerName, Kernel>> = {
  "Convolution Layer #1": {
    stride: 1,
    dimension: 5,
    tick: 10,
  },
  "Max Pool #1": {
    stride: 2,
    dimension: 2,
    tick: 30,
  },
  "Convolution Layer #2": {
    stride: 1,
    dimension: 5,
    tick: 40,
  },
  "Max Pool #2": {
    stride: 3,
    dimension: 3,
    tick: 150,
  },
}
