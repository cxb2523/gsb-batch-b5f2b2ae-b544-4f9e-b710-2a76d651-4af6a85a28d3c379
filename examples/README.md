# Examples

Everything here runs on plain Node.js (>= 22.18, which strips TypeScript
types by default) with no dependencies.

## Headless run

```sh
node examples/basic.ts          # 60 Hz
node examples/basic.ts 240      # 240 Hz — same numbers out
```

The output is identical at every refresh rate because the simulation is
tick-driven; the frame rate only changes how many `frame()` calls deliver the
same elapsed time.

## Playable browser demo

```sh
npm run demo        # bundles src into examples/sim.js, serves on :3000
```

Open <http://localhost:3000/examples/play.html>. Controls:

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | move |
| mouse | steer (needs pointer lock — click the page) |
| `Space` / wheel | jump |
| `Esc` / `P` | pause |
| `R` | restart |
| `H` | toggle auto-hop |

The HUD shows the observable state the task asks for: whether the body is
grounded, current speed, tick count, jump/landing counts and the leftover
accumulator in milliseconds.

Browsers cannot import `.ts` directly, so `scripts/build-demo.mjs` strips the
types into `examples/sim.js`. Re-run it after changing `src/`.

## Browser self-test

Open <http://localhost:3000/tests/browser-selftest.html> (or load it from any
static server). It exercises the bundled `sim.js` in a real browser engine and
prints PASS/FAIL for frame-rate independence, pause/resume and restart.
