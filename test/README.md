# Audio graph lifecycle — tests and reproduction

This directory contains two layers of verification for the converged
play/stop/record node lifecycle in `src/components/noise.js`.

## 1. Fast unit tests (no browser, no Web Audio required)

```
npm test
```

Runs the built-in Node test runner (`node:test`) against the real component
options object. An ESM loader hook (`test/register-loader.mjs`) redirects the
`tone` import to `test/fake-tone.mjs`, an instrumented stand-in that records
every node construction and disposal plus Transport and interval events.

Coverage (`test/noise-lifecycle.test.mjs`, 15 tests):

- `created()` allocates only pooled resources (Players, Recorder, preview
  Player); per-run graph nodes start as `null`.
- `play()` creates exactly one Noise/Filter/Tremolo/LFO/Reverb per kind and
  `stop()` disposes all of them and resets the Transport.
- Repeated play → stop cycles never stack nodes (live count stays at 1, ends
  at 0) while the pooled sample Players survive and are never disposed.
- Sporadic scheduling intervals and timer-mode intervals are all cleared on
  stop (the harness tracks every `setInterval`/`clearInterval`).
- Every slider/`update*` method is a safe no-op when its node does not exist,
  and still reaches the live node during playback and after replay.
- `updateAudioChain()` rewires the effect sub-chain without stacking old
  Filter/Tremolo/LFO nodes, keeping the Noise node alive.
- An LFO is never created when no Filter node exists.
- Recording routes the chain through the Recorder; both `stopRecording()` and
  `cancelRecording()` stop the recorder, clear timers, dispose the graph and
  restore the exact pre-recording configuration.
- Starting a recording releases the previous playback graph first.
- `stop()` with no active graph is a safe no-op, and `beforeDestroy()` also
  disposes the pooled resources.

## 2. Real-browser acceptance test (real Tone.js + Web Audio)

```
npm run test:browser
```

A small static server serves the repo root and the installed Chrome (or Edge,
override with `CHROME_BIN`) is driven headless over the DevTools Protocol by
`test/browser/run-acceptance.mjs`. The page `test/browser/acceptance.html`
loads the actual `src/components/noise.js` against the real Tone.js 14.7.77
UMD bundle (`test/browser/tone-shim.mjs` bridges the bare `tone` import and
wraps the per-run node classes with live/peak instance counters).

It performs, against the real audio graph:

1. play (Filter + Tremolo + LFO + Reverb + sporadic sample) → assert exactly
   one live node of each kind and a started Transport;
2. move the volume/tremolo/LFO/sample sliders and assert they reach the live
   nodes without throwing;
3. stop → all per-run nodes disposed, Transport stopped and reset, every JS
   interval cleared, pooled players still usable, slider calls now no-ops;
4. play again → still exactly one live node per kind (no stacking), new nodes
   inherit current slider values; verify the cutoff slider directly with the
   LFO off; stop again;
5. start a recording → assert the graph is routed into the Recorder's native
   MediaStreamDestination → stop and save: recorder stopped, graph disposed,
   timers cleared, pre-recording volume/noise color/samples restored;
6. cancel a second recording → same teardown and config restore guarantees;
7. normal playback after recording → single graph, clean stop.

The driver prints one PASS/FAIL line per check plus the peak and final live
node counts, and exits non-zero on any failure.

Environment note: Chrome/Edge require a non-default profile directory; the
driver creates one under the OS temp directory. If the automatic browser
discovery fails, point it at a binary explicitly, e.g.
`CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run test:browser`.

## 3. Manual reproduction in the running app

```
npm install --ignore-scripts   # skip the native sqlite3 build if toolchain is absent
npm run serve                  # frontend on http://localhost:8080 (API proxied to :1432)
```

With DevTools → Console open on the noise page:

1. Click **play**, then **stop**, then **play** again. After each stop the
   per-run nodes are disposed (`Tone.getContext().rawContext` shows no
   accumulating graph), only one chain exists at a time, and the volume /
   filter / tremolo sliders keep affecting the current nodes.
2. Enable a sample in **sporadic** mode, play, wait for it to fire, then stop:
   no sporadic interval remains (no further scheduled plays after stop).
3. Open **More… → Record Profile Audio**, record, then **Stop and Save** and
   separately **Cancel**: in both cases the form settings return to what they
   were before recording, the recorder and all timers stop, and pressing
   **play** afterwards starts a fresh, single graph.
