import { check, DEV } from "../development-checks"
import { hasUserActivation, isBrowser } from "../environment"
import type { SoundConfig, SoundName, SoundOptions } from "../schema"
import type { SoundEngine } from "./sound-engine"
import { applySoundConfig, isSoundEnabled, soundPreference, soundVolume } from "./sound-store"

export type { SoundConfig, SoundName, SoundOptions }

export type SoundPlayer = {
  configureSound: (next: SoundConfig) => void
  primeSound: () => void
  playSound: (name: SoundName, options?: SoundOptions) => () => void
}

const noop = () => {}

const loadSoundEngineChunk = (): Promise<SoundEngine> => import("./sound-engine")

export function createSoundPlayer(loadEngineChunk: () => Promise<SoundEngine> = loadSoundEngineChunk): SoundPlayer {
  let engine: Promise<SoundEngine> | null = null
  let loaded: SoundEngine | null = null

  function loadEngine(): Promise<SoundEngine> {
    if (engine) return engine
    const loading = loadEngineChunk().then((value) => {
      loaded = value
      value.setVolume(soundVolume())
      return value
    })
    loading.catch(() => {
      if (engine === loading) engine = null
    })
    engine = loading
    return loading
  }

  soundPreference.subscribe(() => {
    if (isSoundEnabled()) return
    if (loaded) loaded.stopAll()
    else
      engine?.then((value) => {
        if (!isSoundEnabled()) value.stopAll()
      }, noop)
  })

  function configureSound(next: SoundConfig): void {
    if (DEV) check("soundConfig", next, "configureSound() was given settings it cannot use")
    applySoundConfig(next)
    if (loaded) loaded.setVolume(soundVolume())
    else engine?.then((value) => value.setVolume(soundVolume()), noop)
  }

  function primeSound(): void {
    if (!engine && isBrowser() && isSoundEnabled()) loadEngine().catch(noop)
  }

  function playSound(name: SoundName, options?: SoundOptions): () => void {
    if (DEV) check("soundName", name, `playSound("${String(name)}") is not a sound isokit has`)
    if (DEV && options) check("soundOptions", options, `playSound("${String(name)}") was given options it cannot use`)
    if (!isBrowser() || !isSoundEnabled() || !hasUserActivation()) return noop
    let stopped = false
    let stop = noop
    loadEngine().then((value) => {
      if (!stopped && isSoundEnabled()) stop = value.play(name, options)
    }, noop)
    return () => {
      stopped = true
      stop()
    }
  }

  return { configureSound, primeSound, playSound }
}

export const { configureSound, playSound, primeSound } = createSoundPlayer()
