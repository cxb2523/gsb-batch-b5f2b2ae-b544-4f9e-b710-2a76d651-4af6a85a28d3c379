// Builds a lightweight instance of the Noise component options outside of a
// browser: data() is evaluated, methods/computed are bound to the instance,
// Vue-specific APIs ($watch, $http, $forceUpdate) and DOM globals used by the
// recording download path are stubbed. All setInterval/clearInterval calls are
// tracked so tests can prove timers are actually removed.
import noiseOptions from '../src/components/noise.js'
import Tone, { registry, Transport, resetTone } from './fake-tone.mjs'

const trackedIntervals = new Set()
const nativeSetInterval = globalThis.setInterval
const nativeClearInterval = globalThis.clearInterval

// Tests set this to shrink long sporadic intervals (real code schedules in
// seconds) into a window fast enough to observe a fire.
export const intervalScale = { factor: 1 }

export function installDomStubs () {
  globalThis.document = {
    createElement () {
      return { click () {}, setAttribute () {} }
    }
  }
  globalThis.URL = globalThis.URL || {}
  globalThis.URL.createObjectURL = () => 'blob:fake'
  globalThis.URL.revokeObjectURL = () => {}
}

export function installIntervalTracker () {
  globalThis.setInterval = (fn, ms) => {
    const id = nativeSetInterval(fn, ms * intervalScale.factor)
    trackedIntervals.add(id)
    return id
  }
  globalThis.clearInterval = (id) => {
    trackedIntervals.delete(id)
    nativeClearInterval(id)
  }
}

export function restoreTimers () {
  for (const id of trackedIntervals) {
    nativeClearInterval(id)
  }
  trackedIntervals.clear()
  globalThis.setInterval = nativeSetInterval
  globalThis.clearInterval = nativeClearInterval
}

export function activeIntervalCount () {
  return trackedIntervals.size
}

export function makeComponent () {
  const data = noiseOptions.data()
  const instance = {
    ...data,
    _watchers: [],
    $watch (expr, cb) {
      const entry = { expr, cb }
      this._watchers.push(entry)
      return () => {
        const idx = this._watchers.indexOf(entry)
        if (idx !== -1) {
          this._watchers.splice(idx, 1)
        }
      }
    },
    $forceUpdate () {},
    $http: {
      get: async (url) => {
        if (url === '/users/current') {
          return {
            status: 200,
            data: {
              user: {
                canUpload: false,
                darkMode: false,
                preferences: { accentColor: { hex: '#000' } }
              }
            }
          }
        }
        return { status: 200, data: { profiles: [], samples: [] } }
      },
      post: async () => ({ status: 200, data: {} }),
      put: async () => ({ status: 200, data: {} }),
      delete: async () => ({ status: 200, data: {} })
    },
    $vuetify: { theme: { dark: false, themes: { dark: { primary: '' }, light: { primary: '' } } } }
  }

  Object.entries(noiseOptions.methods).forEach(([name, fn]) => {
    instance[name] = fn.bind(instance)
  })

  // Bind lifecycle hooks (created/beforeDestroy) the same way Vue would.
  if (noiseOptions.created) {
    instance.created = noiseOptions.created.bind(instance)
  }
  if (noiseOptions.beforeDestroy) {
    instance.beforeDestroy = noiseOptions.beforeDestroy.bind(instance)
  }

  Object.entries(noiseOptions.computed).forEach(([name, def]) => {
    Object.defineProperty(instance, name, { get: def.bind(instance), configurable: true })
  })

  // Allocate the pooled long-lived resources directly; tests never need the
  // HTTP-driven populate calls inside the real created() hook.
  instance.players = new Tone.Players()
  instance.samplePreviewPlayer = new Tone.Player().toDestination()
  instance.samplePreviewPlayer.loop = true
  instance.recorder = new Tone.Recorder()

  return instance
}

export const sample = (overrides = {}) => ({
  id: 's1',
  name: 'rain',
  volume: -10,
  reverbEnabled: false,
  reverbPreDelay: 0,
  reverbDecay: 2,
  reverbWet: 0.5,
  playbackMode: 'continuous',
  sporadicMin: 1,
  sporadicMax: 2,
  fadeIn: 0,
  loopPointsEnabled: false,
  loopStart: 0,
  loopEnd: 0,
  ...overrides
})

export function addPooledPlayer (component, id) {
  component.players.add(id).toDestination()
}

export { registry, Transport, resetTone }
