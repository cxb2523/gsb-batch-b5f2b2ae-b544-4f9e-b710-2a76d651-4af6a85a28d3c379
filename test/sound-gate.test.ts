// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { clock, fakeAudio, settle } from "./sound-harness"

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

async function harness() {
  const { createSoundEngine } = await import("../src/sound/sound-engine")
  const { createSoundPlayer } = await import("../src/sound/sound-player")
  const { soundPreference } = await import("../src/sound/sound-store")
  const audio = fakeAudio()
  const time = clock()
  const engine = createSoundEngine({ createContext: () => audio.context, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout })
  const player = createSoundPlayer(async () => engine)
  player.configureSound({ defaultOn: true, storageKey: "test:sound" })
  return { player, audio, time, soundPreference }
}

describe("the sound switch as a gate", () => {
  it("cuts every sounding instance the moment the reader turns sound off", async () => {
    const { player, audio, soundPreference } = await harness()
    expect(player.playSound("motor", { duration: 3 })).toBeTypeOf("function")
    player.playSound("cascade", { count: 8, delay: 1, stagger: 0.2 })
    await settle()
    const scheduled = audio.started.length
    expect(scheduled).toBeGreaterThan(0)
    soundPreference.set(false)
    await settle()
    expect(audio.fades.filter((value) => value === 0)).toHaveLength(2)
    expect(audio.started.length).toBe(scheduled)
  })

  it("schedules nothing new while closed", async () => {
    const { player, audio, soundPreference } = await harness()
    soundPreference.set(false)
    expect(player.playSound("press")).toBeTypeOf("function")
    await settle()
    expect(audio.started.length).toBe(0)
    expect(audio.gains.length).toBe(0)
  })

  it("cancels the idle timer on close so nothing suspends while closed", async () => {
    const { player, audio, time, soundPreference } = await harness()
    player.playSound("motor", { duration: 10 })
    await settle()
    expect(time.pending()).toBeGreaterThan(0)
    soundPreference.set(false)
    await settle()
    time.advance(60_000)
    expect(audio.suspended()).toBe(0)
  })

  it("resumes the context and plays at the current volume after reopening", async () => {
    const { player, audio, time, soundPreference } = await harness()
    player.playSound("press")
    await settle()
    time.advance(10_000)
    expect(audio.context.state).toBe("suspended")
    soundPreference.set(false)
    player.configureSound({ volume: 0.25 })
    soundPreference.set(true)
    audio.moveTo(12)
    player.playSound("press")
    await settle()
    expect(audio.resumed()).toBe(1)
    expect(audio.context.state).toBe("running")
    expect(audio.gains[0]?.gain.value).toBeCloseTo(0.25)
  })

  it("pushes configureSound's volume into the loaded engine and later plays", async () => {
    const { player, audio } = await harness()
    player.playSound("press")
    await settle()
    player.configureSound({ volume: 0.4 })
    await settle()
    expect(audio.gains[0]?.gain.value).toBeCloseTo(0.4)
    player.playSound("press")
    await settle()
    expect(audio.gains[0]?.gain.value).toBeCloseTo(0.4)
  })
})
