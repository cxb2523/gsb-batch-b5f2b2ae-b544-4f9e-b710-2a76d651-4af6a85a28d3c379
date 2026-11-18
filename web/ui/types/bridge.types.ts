// Shared message types for the main thread <-> worker bridge.
//
// This module contains types only (plus a tiny constant) so it can be imported
// from both the worker and the main thread — and from tests — without pulling
// in Svelte runes, DOM globals or the worker instance.

export type InitializationRequest = {
  action: "initialize"
  modelURL: string
  inputTensorDimension: number[]
}

export type InitializationResponse = {
  action: "initialize"
  isSuccessful: boolean
  error?: string
}

export type InferenceRequest = {
  action: "run"
  /**
   * Monotonically increasing id assigned by the main thread. The worker echoes
   * it back so late responses can be discarded once a newer drawing exists.
   */
  requestId: number
  inputTensorData: Float32Array
  inputTensorDimension: number[]
  orderedOutputNodeNames: string[]
  finalNodeName: string
}

export type OutputNode = {
  dimension: readonly number[]
  activationMaps: Float32Array
}

export type InferenceResponse = {
  action: "run"
  requestId: number
  isSuccessful: boolean
  orderedOutputNodes: OutputNode[]
  predictions: Float32Array
  error?: string
}
