// Browser-only ESM shim: the real Tone.js ships an extensionless ESM build
// that only resolves through a bundler, so the acceptance page loads the UMD
// bundle (which sets window.Tone) and re-exports it under the bare specifier
// used by src/components/noise.js.
//
// The per-run graph node classes are wrapped once in instrumented subclasses
// so the acceptance page can assert that play/stop cycles never stack nodes.
// Counters are published on window.__toneInstrumentation. The original UMD
// object itself is never mutated.
const instrumentedKinds = ['Noise', 'Filter', 'Tremolo', 'LFO', 'Reverb']
const instrumentation = {
  live: Object.fromEntries(instrumentedKinds.map(k => [k, 0])),
  peak: Object.fromEntries(instrumentedKinds.map(k => [k, 0])),
  wrappers: new Map()
}
window.__toneInstrumentation = instrumentation

for (const kind of instrumentedKinds) {
  const Original = window.Tone[kind]
  class Instrumented extends Original {
    constructor (...args) {
      super(...args)
      instrumentation.live[kind]++
      instrumentation.peak[kind] = Math.max(instrumentation.peak[kind], instrumentation.live[kind])
      const originalDispose = this.dispose.bind(this)
      this.dispose = () => {
        instrumentation.live[kind]--
        return originalDispose()
      }
    }
  }
  // Preserve statics such as Recorder.supported for any future wrapping.
  Object.getOwnPropertyNames(Original).forEach(staticName => {
    if (!['length', 'name', 'prototype'].includes(staticName)) {
      try { Instrumented[staticName] = Original[staticName] } catch { /* read-only */ }
    }
  })
  instrumentation.wrappers.set(kind, Instrumented)
}

const resolveMember = (property) => {
  if (instrumentation.wrappers.has(property)) {
    return instrumentation.wrappers.get(property)
  }
  return window.Tone[property]
}

// Named exports consumed by the application's `import * as Tone from 'tone'`.
// Functions/classes that are never replaced (Transport, Players, Recorder,
// start, ...) delegate lazily to window.Tone so instrumentation and any runtime
// state stays consistent.
export const Noise = resolveMember('Noise')
export const Filter = resolveMember('Filter')
export const Tremolo = resolveMember('Tremolo')
export const LFO = resolveMember('LFO')
export const Reverb = resolveMember('Reverb')
export const Recorder = resolveMember('Recorder')
export const Player = resolveMember('Player')
export const Players = resolveMember('Players')
export const Transport = resolveMember('Transport')
export const getContext = (...args) => window.Tone.getContext(...args)
export const setContext = (...args) => window.Tone.setContext(...args)
export const start = (...args) => window.Tone.start(...args)

// `import Tone from 'tone'` (default) mirrors the UMD global, serving
// instrumented subclasses for the graph node kinds.
export default new Proxy({}, {
  get (_target, property) {
    return resolveMember(property)
  },
  has (_target, property) {
    return property in window.Tone
  },
  ownKeys () {
    return Reflect.ownKeys(window.Tone)
  },
  getOwnPropertyDescriptor (_target, property) {
    return Object.getOwnPropertyDescriptor(window.Tone, property)
  }
})
