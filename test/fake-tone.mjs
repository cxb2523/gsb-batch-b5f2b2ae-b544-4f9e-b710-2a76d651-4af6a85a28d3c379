// Instrumented stand-in for the `tone` package used by the lifecycle tests.
// It implements just the surface exercised by src/components/noise.js while
// recording every construction, disposal and timer event, so tests can assert
// that play/stop/record converge on a bounded, re-creatable graph.
//
// All instances register themselves in the shared `registry`; `resetTone()`
// clears it between tests.

export const registry = {
  instances: [],
  byKind (kind) {
    return this.instances.filter(i => i.kind === kind)
  },
  live (kind) {
    return this.instances.filter(i => i.kind === kind && !i.disposed)
  },
  reset () {
    this.instances.length = 0
    Transport.reset()
  }
}

let sequence = 0

class FakeNode {
  constructor (kind, opts = {}) {
    this.kind = kind
    this.id = ++sequence
    this.disposed = false
    this.connected = []
    this.disconnectCount = 0
    this.startCount = 0
    this.stopCount = 0
    this.options = { ...opts }
    this.volume = { value: opts.volume !== undefined ? opts.volume : 0 }
    this.frequency = { kind: 'Param' }
    this.loop = false
    this.fadeIn = 0
    this.buffer = { duration: 10 }
    registry.instances.push(this)
  }

  connect (target) {
    this.connected.push(target)
    return this
  }

  disconnect () {
    this.disconnectCount++
    this.connected = []
    return this
  }

  toDestination () {
    this.connected.push({ destination: true })
    return this
  }

  start () {
    this.startCount++
    return this
  }

  stop () {
    this.stopCount++
    return this
  }

  sync () {
    this.synced = true
    return this
  }

  unsync () {
    this.synced = false
    return this
  }

  set (values) {
    Object.assign(this.options, values)
    return this
  }

  setLoopPoints (start, end) {
    this.loopStart = start
    this.loopEnd = end
    return this
  }

  dispose () {
    if (this.disposed) {
      throw new Error(`${this.kind}#${this.id} disposed twice`)
    }
    this.disposed = true
    return this
  }
}

class FakeNoise extends FakeNode {
  constructor (opts) {
    super('Noise', opts)
    this.type = (opts && opts.type) || 'pink'
  }
}

class FakeFilter extends FakeNode {
  constructor (cutoff, type) {
    super('Filter', { cutoff, type })
    this.type = type
  }
}

class FakeTremolo extends FakeNode {
  constructor (opts) {
    super('Tremolo', opts)
  }
}

class FakeLFO extends FakeNode {
  constructor (opts) {
    super('LFO', opts)
  }
}

class FakeReverb extends FakeNode {
  constructor (decay) {
    super('Reverb', { decay })
    this.ready = Promise.resolve()
  }
}

class FakeRecorder extends FakeNode {
  constructor () {
    super('Recorder')
    this._state = 'stopped'
  }

  get state () {
    return this._state
  }

  async start () {
    this.startCount++
    this._state = 'started'
  }

  async stop () {
    if (this._state !== 'started') {
      throw new Error('Recorder is not started')
    }
    this.stopCount++
    this._state = 'stopped'
    return { blob: true, size: 1 }
  }
}

class FakePlayer extends FakeNode {
  constructor () {
    super('Player')
    this.volume = { value: 0 }
  }
}

class FakePlayers {
  constructor () {
    this.kind = 'Players'
    this.id = ++sequence
    this.disposed = false
    this._players = new Map()
    this.loaded = true
    registry.instances.push(this)
  }

  add (id) {
    const player = new FakePlayer()
    this._players.set(id, player)
    return player
  }

  has (id) {
    return this._players.has(id)
  }

  player (id) {
    if (!this._players.has(id)) {
      throw new Error(`Unknown player ${id}`)
    }
    return this._players.get(id)
  }

  dispose () {
    this.disposed = true
    return this
  }
}

export const Transport = {
  state: 'stopped',
  position: 0,
  loopStart: 0,
  loopEnd: '4m',
  startCount: 0,
  stopCount: 0,
  cancelCount: 0,
  start () {
    this.startCount++
    this.state = 'started'
  },
  stop () {
    this.stopCount++
    this.state = 'stopped'
  },
  cancel () {
    this.cancelCount++
  },
  reset () {
    this.state = 'stopped'
    this.position = 0
    this.loopStart = 0
    this.loopEnd = '4m'
    this.startCount = 0
    this.stopCount = 0
    this.cancelCount = 0
  }
}

export function resetTone () {
  registry.reset()
}

// Named exports so `import * as Tone from 'tone'` resolves every member used
// by the component (Tone.Noise, Tone.Transport, Tone.start, ...).
export const Noise = FakeNoise
export const Filter = FakeFilter
export const Tremolo = FakeTremolo
export const LFO = FakeLFO
export const Reverb = FakeReverb
export const Recorder = FakeRecorder
export const Player = FakePlayer
export const Players = FakePlayers
export const start = async () => undefined

export default {
  Noise: FakeNoise,
  Filter: FakeFilter,
  Tremolo: FakeTremolo,
  LFO: FakeLFO,
  Reverb: FakeReverb,
  Recorder: FakeRecorder,
  Player: FakePlayer,
  Players: FakePlayers,
  Transport,
  start: async () => undefined
}
