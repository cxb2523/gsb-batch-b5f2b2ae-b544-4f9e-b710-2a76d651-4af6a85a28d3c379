import { describe, expect, it } from "vitest"
import { createSoundEngine } from "../src/sound/sound-engine"
import { clock, fakeAudio, settle } from "./sound-harness"

function setup() {
  const audio = fakeAudio()
  const time = clock()
  const engine = createSoundEngine({ createContext: () => audio.context, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout })
  return { audio, time, engine }
}

describe("sound engine", () => {
  it("fades and drops every sounding instance when stopped, and schedules nothing new", async () => {
    const { audio, engine } = setup()
    engine.play("motor", { duration: 3 })
    engine.play("cascade", { count: 8, delay: 1, stagger: 0.2 })
    await settle()
    const voicesBefore = audio.started.length
    expect(voicesBefore).toBeGreaterThan(0)
    engine.stopAll()
    expect(audio.fades.filter((value) => value === 0)).toHaveLength(2)
    expect(audio.started.length).toBe(voicesBefore)
  })

  it("cancels the idle timer on stop, so nothing suspends while closed", async () => {
    const { audio, time, engine } = setup()
    engine.play("motor", { duration: 10 })
    await settle()
    expect(time.pending()).toBeGreaterThan(0)
    engine.stopAll()
    time.advance(60_000)
    expect(audio.suspended()).toBe(0)
  })

  it("still suspends after the longest sound when left alone", async () => {
    const { audio, time, engine } = setup()
    engine.play("motor", { duration: 2 })
    await settle()
    time.advance(10_000)
    expect(audio.suspended()).toBe(1)
  })

  it("does not let an old timer suspend a sound played after reopening", async () => {
    const { audio, time, engine } = setup()
    engine.play("motor", { duration: 4 })
    await settle()
    engine.stopAll()
    audio.moveTo(5)
    engine.play("charge", { duration: 6 })
    await settle()
    time.advance(5_000)
    expect(audio.suspended()).toBe(0)
  })

  it("resumes a suspended context for the next play", async () => {
    const { audio, time, engine } = setup()
    engine.play("press")
    await settle()
    time.advance(10_000)
    expect(audio.context.state).toBe("suspended")
    audio.moveTo(10)
    engine.play("press")
    await settle()
    expect(audio.resumed()).toBe(1)
    expect(audio.context.state).toBe("running")
  })

  it("keeps the loaded graph and later plays at the new volume", async () => {
    const { audio, engine } = setup()
    engine.play("press")
    await settle()
    engine.setVolume(0.2)
    expect(audio.gains[0]?.gain.value).toBeCloseTo(0.2)
    engine.play("press")
    await settle()
    expect(audio.gains[0]?.gain.value).toBeCloseTo(0.2)
    const fresh = setup()
    fresh.engine.setVolume(0.35)
    fresh.engine.play("press")
    await settle()
    expect(fresh.audio.gains[0]?.gain.value).toBeCloseTo(0.35)
  })
})
