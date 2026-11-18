// Simulation-clock state machine for the Helios page: one mutable sim object
// plus the four operations the UI can perform. Kept free of React so the
// convergence invariants (single fast-forward target, cancel-on-manual-speed,
// arrival exactly on target, clean disposal) can be tested in plain Node.
import { daysSinceJ2000, nextSolarEclipses } from '../data/astro.js'

export const DEFAULT_SPEED = 7 // days per second

export function createSolarSim(nowMs) {
  const sim = {
    t: daysSinceJ2000(nowMs), // simulated time, days since J2000
    speed: DEFAULT_SPEED,     // days per second when not fast-forwarding
    target: null,             // fast-forward target time, or null
    pending: null,            // eclipse awaiting display on arrival
    seeking: false,           // a fast-forward is in flight
    eclipse: null,            // arrived-at eclipse (card shown)
  }

  /* Manual speed/pause: cancels any fast-forward, drops the pending result
     and any shown card. */
  const setSpeed = (v) => {
    sim.speed = v
    sim.target = null
    sim.pending = null
    sim.seeking = false
    sim.eclipse = null
  }

  /* Starts a fast-forward to the next eclipse. Ignored while one is already
     in flight, so the target can never be swapped mid-seek. Returns the
     eclipse being sought, or null if the call was a no-op. */
  const predict = () => {
    if (sim.seeking) return null
    const e = nextSolarEclipses(sim.t + 0.5, 1)[0]
    if (!e) return null
    sim.pending = e
    sim.target = e.t
    sim.seeking = true
    sim.eclipse = null
    return e
  }

  /* Advances simulated time by `delta` real seconds; eases toward the target
     when fast-forwarding. Returns the arrived-at eclipse on the landing tick
     (exactly once per prediction), otherwise null. */
  const tick = (delta) => {
    if (sim.target != null) {
      const remaining = sim.target - sim.t
      const step = Math.min(Math.max(remaining * 2.2 * delta, 4 * delta), 130 * delta)
      if (remaining <= step + 1e-4) {
        sim.t = sim.target
        sim.target = null
        sim.speed = 0
        const arrived = sim.pending
        sim.pending = null
        sim.seeking = false
        sim.eclipse = arrived
        return arrived
      }
      sim.t += step
    } else {
      sim.t += sim.speed * delta
    }
    return null
  }

  /* Releases in-flight state when the page unmounts. */
  const dispose = () => {
    sim.target = null
    sim.pending = null
    sim.seeking = false
  }

  return { sim, setSpeed, predict, tick, dispose }
}
