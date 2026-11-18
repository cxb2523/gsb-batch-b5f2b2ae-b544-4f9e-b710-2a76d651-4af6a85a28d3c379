import type { SoundName, SoundOptions } from "../schema"
import { amount, RECIPES } from "./sound-recipes"

type AudioGraph = { context: AudioContext; master: GainNode; noise: AudioBuffer }

type EngineHost = {
  createContext: () => AudioContext
  setTimeout: (handler: () => void, ms: number) => number
  clearTimeout: (id: number) => void
}

export type SoundEngine = {
  play: (name: SoundName, options?: SoundOptions) => () => void
  setVolume: (next: number) => void
  stopAll: () => void
}

const silent = () => {}

const START_OFFSET_SECONDS = 0.005
const PITCH_SPREAD = 0.06
const BUS_RELEASE_SECONDS = 0.2
const STOP_FADE_SECONDS = 0.015
const STOP_DISCONNECT_MS = 150
const MIN_IDLE_SECONDS = 4
const IDLE_MARGIN_SECONDS = 0.5

const SIZE_REFERENCE = 0.15
const SEMITONES_PER_SIZE = 12
const SEMITONE_REACH = 2
const THROTTLE_SECONDS: Partial<Record<SoundName, number>> = { tick: 0.03, roll: 0.03 }

const sizePitch = (size: number | undefined): number => (size === undefined ? 1 : 2 ** (amount((SIZE_REFERENCE - size) * SEMITONES_PER_SIZE, -SEMITONE_REACH, SEMITONE_REACH, 0) / 12))

const prefersStillness = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

const browserHost: EngineHost = {
  createContext() {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    return new AudioContextClass({ latencyHint: "interactive" })
  },
  setTimeout,
  clearTimeout,
}

function buildGraph(context: AudioContext, volume: number): AudioGraph {
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = -14
  limiter.knee.value = 8
  limiter.ratio.value = 4
  limiter.attack.value = 0.002
  limiter.release.value = 0.12
  const master = context.createGain()
  master.gain.value = volume
  master.connect(limiter).connect(context.destination)
  const noise = context.createBuffer(1, context.sampleRate / 2, context.sampleRate)
  const samples = noise.getChannelData(0)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
  return { context, master, noise }
}

export function createSoundEngine(host: EngineHost): SoundEngine {
  let graph: AudioGraph | null = null
  let volume = 0.55
  let idleTimer = 0
  let quietAt = 0
  const playing = new Set<() => void>()
  const lastPlayed = new Map<SoundName, number>()

  function scheduleIdle(context: AudioContext, length: number): void {
    quietAt = Math.max(quietAt, context.currentTime + length)
    host.clearTimeout(idleTimer)
    const waitSeconds = Math.max(MIN_IDLE_SECONDS, quietAt - context.currentTime + IDLE_MARGIN_SECONDS)
    idleTimer = host.setTimeout(() => {
      if (context.state === "running") context.suspend()
    }, waitSeconds * 1000)
  }

  function setVolume(next: number): void {
    volume = Math.max(0, Math.min(1, next))
    if (graph) graph.master.gain.value = volume
  }

  function stopAll(): void {
    quietAt = 0
    host.clearTimeout(idleTimer)
    for (const stop of playing) stop()
  }

  function play(name: SoundName, options: SoundOptions = {}): () => void {
    const recipe = Object.hasOwn(RECIPES, name) ? RECIPES[name] : undefined
    if (!recipe) return silent
    graph ??= buildGraph(host.createContext(), volume)
    const { context, master, noise } = graph
    const gap = THROTTLE_SECONDS[name]
    if (gap !== undefined && context.currentTime - (lastPlayed.get(name) ?? -1) < gap) return silent
    lastPlayed.set(name, context.currentTime)
    const bus = context.createGain()
    const panner = options.pan && context.createStereoPanner ? context.createStereoPanner() : null
    if (panner) {
      panner.pan.value = amount(options.pan, -1, 1, 0)
      bus.connect(panner).connect(master)
    } else bus.connect(master)
    const release = () => {
      bus.disconnect()
      panner?.disconnect()
    }
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      playing.delete(stop)
      bus.gain.setTargetAtTime(0, context.currentTime, STOP_FADE_SECONDS)
      host.setTimeout(release, STOP_DISCONNECT_MS)
    }
    const start = () => {
      if (stopped) return
      const pitch = (1 + (Math.random() - 0.5) * PITCH_SPREAD) * sizePitch(options.size)
      const length = recipe({ context, bus, noise, startAt: context.currentTime + START_OFFSET_SECONDS }, { pitch, still: prefersStillness(), options })
      host.setTimeout(stop, (length + BUS_RELEASE_SECONDS) * 1000)
      scheduleIdle(context, length)
    }
    playing.add(stop)
    if (context.state === "running") start()
    else context.resume().then(start, () => {})
    return stop
  }

  return { play, setVolume, stopAll }
}

export const { play, setVolume, stopAll } = createSoundEngine(browserHost)
