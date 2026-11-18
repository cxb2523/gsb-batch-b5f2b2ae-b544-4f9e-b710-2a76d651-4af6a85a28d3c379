type Param = {
  value: number
  setValueAtTime: (value: number, time: number) => void
  exponentialRampToValueAtTime: (value: number, time: number) => void
  setTargetAtTime: (value: number, time: number, constant: number) => void
}

export function param(value = 0): Param {
  const knob: Param = {
    value,
    setValueAtTime(next) {
      knob.value = next
    },
    exponentialRampToValueAtTime(next) {
      knob.value = next
    },
    setTargetAtTime(next) {
      knob.value = next
    },
  }
  return knob
}

const fakeNode = () => ({ connect: (next: unknown) => next, disconnect() {} })

export function fakeAudio() {
  const gains: { gain: Param }[] = []
  const fades: number[] = []
  const started: number[] = []
  let suspended = 0
  let resumed = 0
  let time = 0
  const context = {
    get currentTime() {
      return time
    },
    sampleRate: 48000,
    state: "running" as AudioContextState,
    destination: fakeNode(),
    createDynamicsCompressor: () => ({ ...fakeNode(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createGain: () => {
      const gain = param()
      const node = { ...fakeNode(), gain }
      gain.setTargetAtTime = (next: number) => {
        fades.push(next)
        gain.value = next
      }
      gains.push(node)
      return node
    },
    createBuffer: (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
    createOscillator: () => ({ ...fakeNode(), type: "sine", frequency: param(), start: () => started.push(1), stop() {} }),
    createBufferSource: () => ({ ...fakeNode(), buffer: null, loop: false, start: () => started.push(1), stop() {} }),
    createBiquadFilter: () => ({ ...fakeNode(), type: "bandpass", frequency: param(), Q: param() }),
    resume: () => {
      resumed++
      context.state = "running"
      return Promise.resolve()
    },
    suspend: () => {
      suspended++
      context.state = "suspended"
      return Promise.resolve()
    },
  }
  return {
    context: context as unknown as AudioContext,
    gains,
    fades,
    started,
    moveTo: (seconds: number) => {
      time = seconds
    },
    suspended: () => suspended,
    resumed: () => resumed,
  }
}

export function clock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    setTimeout: (run: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    },
    advance: (ms: number) => {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.run()
      }
    },
    pending: () => timers.size,
  }
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
