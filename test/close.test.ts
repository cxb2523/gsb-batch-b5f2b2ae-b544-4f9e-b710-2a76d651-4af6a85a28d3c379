// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContextClosedError, createSeslen } from "../src/index.ts"

/* ------------------------------------------------------------------ fakes */

const instances: FakeAudioContext[] = []

class FakeAudioContext {
  state: "suspended" | "running" | "closed" = "suspended"
  destination = makeNode()
  currentTime = 0
  sampleRate = 44100
  baseLatency = 0.005
  outputLatency = 0.01
  resume = vi.fn(async () => {
    this.state = "running"
  })
  suspend = vi.fn(async () => {
    this.state = "suspended"
  })
  close = vi.fn(async () => {
    this.state = "closed"
  })
  // Default resolves immediately; tests can swap in a controllable pending one.
  decodeAudioData = vi.fn(async () => makeBuffer())
  createBuffer = vi.fn(() => makeBuffer())
  createBufferSource = vi.fn(() => makeSource())
  createGain = vi.fn(() => makeGain())
  createOscillator = vi.fn(() => makeOscillator())
  createBiquadFilter = vi.fn(() => makeFilter())
  createStereoPanner = vi.fn(() => makePanner())
  createAnalyser = vi.fn(() => makeAnalyser())

  constructor() {
    instances.push(this)
  }
}

function makePanner(): ReturnType<typeof makeNode> & { pan: ReturnType<typeof param> } {
  return Object.assign(makeNode(), { pan: param() })
}
function makeAnalyser(): ReturnType<typeof makeNode> & {
  fftSize: number
  frequencyBinCount: number
  smoothingTimeConstant: number
  minDecibels: number
  maxDecibels: number
  getByteTimeDomainData: ReturnType<typeof vi.fn>
  getByteFrequencyData: ReturnType<typeof vi.fn>
  getFloatTimeDomainData: ReturnType<typeof vi.fn>
  getFloatFrequencyData: ReturnType<typeof vi.fn>
} {
  return Object.assign(makeNode(), {
    fftSize: 2048,
    frequencyBinCount: 1024,
    smoothingTimeConstant: 0.8,
    minDecibels: -100,
    maxDecibels: -30,
    getByteTimeDomainData: vi.fn(),
    getByteFrequencyData: vi.fn(),
    getFloatTimeDomainData: vi.fn(),
    getFloatFrequencyData: vi.fn(),
  })
}

function param(): {
  value: number
  setValueAtTime: () => void
  linearRampToValueAtTime: () => void
  exponentialRampToValueAtTime: () => void
  cancelScheduledValues: () => void
} {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  }
}
function makeNode(): { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } {
  const node = {
    connect: vi.fn(() => node),
    disconnect: vi.fn(),
  }
  return node
}
function makeGain(): ReturnType<typeof makeNode> & { gain: ReturnType<typeof param> } {
  return Object.assign(makeNode(), { gain: param() })
}
interface FakeBuffer {
  duration: number
  length: number
  numberOfChannels: number
  sampleRate: number
  getChannelData: () => Float32Array
}
function makeBuffer(): FakeBuffer {
  return {
    duration: 0.2,
    length: 8820,
    numberOfChannels: 1,
    sampleRate: 44100,
    getChannelData: () => new Float32Array(8820),
  }
}

function makeSource(): ReturnType<typeof makeNode> & {
  buffer: unknown
  loop: boolean
  playbackRate: ReturnType<typeof param>
  detune: ReturnType<typeof param>
  onended: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  return Object.assign(makeNode(), {
    buffer: null,
    loop: false,
    playbackRate: param(),
    detune: param(),
    onended: null,
    start: vi.fn(),
    stop: vi.fn(),
  })
}
function makeOscillator(): ReturnType<typeof makeNode> & {
  type: string
  frequency: ReturnType<typeof param>
  detune: ReturnType<typeof param>
  onended: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  return Object.assign(makeNode(), {
    type: "sine",
    frequency: param(),
    detune: param(),
    onended: null,
    start: vi.fn(),
    stop: vi.fn(),
  })
}
function makeFilter(): ReturnType<typeof makeNode> & {
  type: string
  frequency: ReturnType<typeof param>
  Q: ReturnType<typeof param>
  gain: ReturnType<typeof param>
} {
  return Object.assign(makeNode(), {
    type: "lowpass",
    frequency: param(),
    Q: param(),
    gain: param(),
  })
}

/** A fetch whose response can be released on demand. Honours AbortSignal,
 *  rejecting with an AbortError just like the browser's `fetch`. */
function pendingFetch(): {
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>
  resolve: () => void
  reject: (e: unknown) => void
  signal: () => AbortSignal | undefined
} {
  let resolveResponse!: () => void
  let rejectResponse!: (e: unknown) => void
  let lastSignal: AbortSignal | undefined
  const response = new Promise<unknown>((resolve, reject) => {
    resolveResponse = () => resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
    rejectResponse = reject
  })
  return {
    fetchImpl: (_url, init) => {
      lastSignal = init?.signal
      if (init?.signal) {
        if (init.signal.aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"))
        }
        init.signal.addEventListener("abort", () => {
          rejectResponse(new DOMException("Aborted", "AbortError"))
        })
      }
      return response
    },
    resolve: resolveResponse,
    reject: rejectResponse,
    signal: () => lastSignal,
  }
}

beforeEach(() => {
  instances.length = 0
  ;(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  }))
})

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext
  delete (globalThis as { fetch?: unknown }).fetch
})

/* ------------------------------------------------------------ reopen path */

describe("seslen close() — recoverable reset", () => {
  it("rebuilds the context, master gain and buses after close()", async () => {
    const ses = createSeslen({ sources: { tick: "/tick.mp3" }, buses: { ui: {} } })
    await ses.play("tick")

    expect(instances).toHaveLength(1)
    const first = instances[0]!
    expect(first.state).not.toBe("closed")
    const firstUi = ses.bus("ui")
    const firstUiNode = first.createGain.mock.results.map((r) => r.value)

    await ses.close()
    expect(first.state).toBe("closed")
    expect(ses.state()).toBe("idle")

    // Replay boots a brand-new context.
    const handle = await ses.play("tick")
    expect(handle).not.toBeNull()
    expect(instances).toHaveLength(2)
    const second = instances[1]!
    expect(second).not.toBe(first)
    expect(second.state).not.toBe("closed")

    // The bus is recreated on the new context with fresh gain nodes.
    const secondUi = ses.bus("ui")
    expect(secondUi).not.toBe(firstUi)
    expect(secondUi.name).toBe("ui")
    const secondUiNode = second.createGain.mock.results.map((r) => r.value)
    for (const node of firstUiNode) expect(secondUiNode).not.toContain(node)
  })

  it("drops the old analyser and creates a fresh one on the new context", async () => {
    const ses = createSeslen({ sources: { tick: "/tick.mp3" } })
    await ses.play("tick")
    const first = instances[0]!

    const firstTap = ses.analyser({ fftSize: 256 })
    expect(first.createAnalyser).toHaveBeenCalledTimes(1)
    const firstAnalyserNode = first.createAnalyser.mock.results[0]!.value
    firstTap.getWaveform(new Uint8Array(32))
    expect(firstAnalyserNode.getByteTimeDomainData).toHaveBeenCalledTimes(1)

    await ses.close()
    // Disposal disconnects the dead analyser node.
    expect(firstAnalyserNode.disconnect).toHaveBeenCalled()

    const secondTap = ses.analyser({ fftSize: 512 })
    const second = instances[1]!
    expect(second.createAnalyser).toHaveBeenCalledTimes(1)
    const secondAnalyserNode = second.createAnalyser.mock.results[0]!.value
    expect(secondAnalyserNode).not.toBe(firstAnalyserNode)

    // The new tap routes to the live analyser; the old one stays dead.
    secondTap.getWaveform(new Uint8Array(32))
    expect(secondAnalyserNode.getByteTimeDomainData).toHaveBeenCalledTimes(1)
    expect(firstAnalyserNode.getByteTimeDomainData).toHaveBeenCalledTimes(1)
    expect(secondTap).not.toBe(firstTap)
  })

  it("rebuilds the URL cache: a post-reopen play re-decodes on the new context", async () => {
    const ses = createSeslen({ sources: { tick: "/tick.mp3" } })
    await ses.play("tick")
    const first = instances[0]!
    expect(first.decodeAudioData).toHaveBeenCalledTimes(1)

    await ses.close()
    await ses.play("tick")

    const second = instances[1]!
    expect(second).not.toBe(first)
    expect(second.decodeAudioData).toHaveBeenCalledTimes(1)
    // The closed context never receives post-reopen decodes.
    expect(first.decodeAudioData).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(2)
  })

  it("post-reopen handles stop correctly and leave no stale voice entries", async () => {
    const ses = createSeslen({
      sources: { tick: "/tick.mp3" },
      defaults: { tick: { voices: 1, steal: "drop" } },
    })
    const before = await ses.play("tick")
    expect(before).not.toBeNull()
    // At the cap: another play is dropped.
    expect(await ses.play("tick")).toBeNull()

    await ses.close()
    expect(before!.done).toBe(true)

    // Voices were reset — the first play on the new generation is admitted.
    const after = await ses.play("tick")
    expect(after).not.toBeNull()
    expect(after!.done).toBe(false)

    // The new handle is fully controllable via stop()/stopAll().
    after!.stop()
    expect(after!.done).toBe(true)

    const again = await ses.play("tick")
    expect(again).not.toBeNull()
    expect(() => ses.stopAll()).not.toThrow()
    expect(again!.done).toBe(true)
  })

  it("keeps the master volume setting across a close/reopen cycle", async () => {
    const ses = createSeslen({ sources: { tick: "/tick.mp3" }, volume: 0.4 })
    ses.setVolume(0.7)
    await ses.play("tick")
    await ses.close()
    await ses.play("tick")
    expect(ses.getVolume()).toBe(0.7)
    const second = instances[1]!
    const masterGain = second.createGain.mock.results[0]!.value
    expect(masterGain.gain.value).toBe(0.7)
  })

  /* ------------------------------------------------------- cancel-on-close */

  it("cancels a play awaiting decode: rejects with ContextClosedError, no voice starts", async () => {
    let resolveDecode!: () => void
    const pending = new Promise<FakeBuffer>((resolve) => {
      resolveDecode = () => resolve(makeBuffer())
    })
    const ses = createSeslen({ sources: { tick: "/tick.mp3" } })
    // Boot the lazy context, then take over its decoder.
    void ses.play("tick").catch(() => {})
    await Promise.resolve()
    const boot = instances[0]!
    boot.decodeAudioData = vi.fn(() => pending)

    const playPromise = ses.play("tick")
    const playEvents: unknown[] = []
    ses.on("play", (e) => playEvents.push(e))

    await ses.close()
    resolveDecode()

    await expect(playPromise).rejects.toBeInstanceOf(ContextClosedError)
    // Nothing was ever started on the closed context…
    expect(boot.createBufferSource).not.toHaveBeenCalled()
    // …and no play event leaked for the cancelled call.
    expect(playEvents).toEqual([])
    expect(boot.state).toBe("closed")
  })

  it("aborts the in-flight fetch and surfaces the abort as ContextClosedError", async () => {
    const controlled = pendingFetch()
    ;(globalThis as { fetch?: unknown }).fetch = vi.fn(controlled.fetchImpl)

    const ses = createSeslen({ sources: { slow: "/slow.mp3" } })
    const playPromise = ses.play("slow")

    // Let the microtask start the fetch.
    await Promise.resolve()
    const boot = instances[0]!
    expect(controlled.signal()).toBeInstanceOf(AbortSignal)
    expect(controlled.signal()!.aborted).toBe(false)

    await ses.close()
    expect(controlled.signal()!.aborted).toBe(true)
    await expect(playPromise).rejects.toBeInstanceOf(ContextClosedError)
    // Decode never ran because the fetch never produced a response.
    expect(boot.decodeAudioData).not.toHaveBeenCalled()
    // Releasing the old (aborted) fetch later must not resurrect anything.
    controlled.resolve()
    await Promise.resolve()
    expect(boot.createBufferSource).not.toHaveBeenCalled()
  })

  it("cancels every pending play, not just the first one", async () => {
    let resolveDecode!: () => void
    const pending = new Promise<FakeBuffer>((resolve) => {
      resolveDecode = () => resolve(makeBuffer())
    })
    const ses = createSeslen({
      sources: { a: "/a.mp3", b: "/b.mp3" },
    })
    // Boot the lazy context, then take over its decoder.
    void ses.play("a").catch(() => {})
    await Promise.resolve()
    const boot = instances[0]!
    boot.decodeAudioData = vi.fn(() => pending)

    const p1 = ses.play("a")
    const p2 = ses.play("b")
    await ses.close()
    resolveDecode()

    await expect(p1).rejects.toBeInstanceOf(ContextClosedError)
    await expect(p2).rejects.toBeInstanceOf(ContextClosedError)
    expect(boot.createBufferSource).not.toHaveBeenCalled()
  })

  it("cancels a pending preload() with ContextClosedError", async () => {
    let resolveDecode!: () => void
    const pending = new Promise<FakeBuffer>((resolve) => {
      resolveDecode = () => resolve(makeBuffer())
    })
    const ses = createSeslen({ sources: { tick: "/tick.mp3" } })
    // Boot the lazy context, then take over its decoder.
    void ses.play("tick").catch(() => {})
    await Promise.resolve()
    const boot = instances[0]!
    boot.decodeAudioData = vi.fn(() => pending)

    const preloadPromise = ses.preload("tick")
    await ses.close()
    resolveDecode()
    await expect(preloadPromise).rejects.toBeInstanceOf(ContextClosedError)
  })

  it("a cancelled play does not poison the next generation", async () => {
    let resolveDecode!: () => void
    const pending = new Promise<FakeBuffer>((resolve) => {
      resolveDecode = () => resolve(makeBuffer())
    })
    const ses = createSeslen({ sources: { tick: "/tick.mp3" } })
    // Boot the lazy context, then take over its decoder.
    void ses.play("tick").catch(() => {})
    await Promise.resolve()
    const boot = instances[0]!
    boot.decodeAudioData = vi.fn(() => pending)

    const cancelled = ses.play("tick")
    await ses.close()
    resolveDecode()
    await expect(cancelled).rejects.toBeInstanceOf(ContextClosedError)

    // Fresh generation, fresh decode — plays normally.
    const handle = await ses.play("tick")
    expect(handle).not.toBeNull()
    expect(instances).toHaveLength(2)
    const next = instances[1]!
    expect(next.decodeAudioData).toHaveBeenCalledTimes(1)
    expect(next.createBufferSource).toHaveBeenCalledTimes(1)
  })

  /* --------------------------------------------------------- idempotency */

  it("close() is idempotent: repeated and concurrent calls never throw", async () => {
    const ses = createSeslen({ sources: { tick: "/tick.mp3" } })
    await ses.play("tick")
    const boot = instances[0]!

    await expect(Promise.all([ses.close(), ses.close(), ses.close()])).resolves.toBeDefined()
    expect(boot.close).toHaveBeenCalledTimes(1)

    // Calling again on an already-idle instance is a silent no-op.
    await expect(ses.close()).resolves.toBeUndefined()
    await expect(ses.close()).resolves.toBeUndefined()
    expect(ses.state()).toBe("idle")
  })

  it("close() before the context ever booted is a harmless no-op", async () => {
    const ses = createSeslen({ sources: { tick: "/tick.mp3" } })
    expect(instances).toHaveLength(0)
    await expect(ses.close()).resolves.toBeUndefined()
    expect(ses.state()).toBe("idle")
    // And playback still works afterwards.
    const handle = await ses.play("tick")
    expect(handle).not.toBeNull()
    expect(instances).toHaveLength(1)
  })
})
