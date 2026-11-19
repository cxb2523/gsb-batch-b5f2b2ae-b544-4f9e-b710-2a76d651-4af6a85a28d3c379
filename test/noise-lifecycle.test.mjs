import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeComponent,
  sample,
  addPooledPlayer,
  registry,
  Transport,
  resetTone,
  activeIntervalCount,
  installDomStubs,
  installIntervalTracker,
  restoreTimers,
  intervalScale
} from './helpers.mjs'

beforeEach(() => {
  resetTone()
  installDomStubs()
  installIntervalTracker()
  intervalScale.factor = 1
})

afterEach(() => {
  restoreTimers()
})

function newComponentWithSample (sampleOverrides = {}) {
  const c = makeComponent()
  const s = sample(sampleOverrides)
  c.loadedSamples = [s]
  addPooledPlayer(c, s.id)
  return { c, s }
}

test('created() only allocates pooled resources, no per-run graph nodes', () => {
  const c = makeComponent()
  c.created()

  assert.equal(c.noise, null)
  assert.equal(c.filter, null)
  assert.equal(c.tremolo, null)
  assert.equal(c.lfo, null)
  assert.deepEqual(c.sampleReverbs, [])
  assert.ok(c.players)
  assert.ok(c.recorder)
  assert.ok(c.samplePreviewPlayer)
})

test('play() builds one graph and stop() disposes every per-run node', async () => {
  const { c, s } = newComponentWithSample({ reverbEnabled: true })
  c.isFilterEnabled = true
  c.isTremoloEnabled = true
  c.isLFOFilterCutoffEnabled = true

  await c.play()

  assert.equal(registry.live('Noise').length, 1)
  assert.equal(registry.live('Filter').length, 1)
  assert.equal(registry.live('Tremolo').length, 1)
  assert.equal(registry.live('LFO').length, 1)
  assert.equal(registry.live('Reverb').length, 1)
  assert.equal(Transport.state, 'started')

  c.stop()

  for (const kind of ['Noise', 'Filter', 'Tremolo', 'LFO', 'Reverb']) {
    assert.equal(registry.live(kind).length, 0, `all ${kind} nodes must be disposed on stop`)
  }
  assert.equal(c.noise, null)
  assert.equal(c.filter, null)
  assert.equal(c.tremolo, null)
  assert.equal(c.lfo, null)
  assert.deepEqual(c.sampleReverbs, [])
  assert.equal(Transport.state, 'stopped')
  assert.equal(Transport.position, 0)
  assert.equal(Transport.loopEnd, '4m')
  assert.equal(c.playDisabled, false)
  // Pooled player survives and is re-routed to destination, not disposed.
  assert.equal(c.players.has(s.id), true)
  assert.equal(c.players.player(s.id).disposed, false)
})

test('repeated play/stop does not stack nodes', async () => {
  const { c } = newComponentWithSample()

  for (let run = 1; run <= 3; run++) {
    await c.play()
    assert.equal(registry.live('Noise').length, 1, `run ${run}: exactly one live Noise`)
    c.stop()
    assert.equal(registry.live('Noise').length, 0, `run ${run}: Noise cleaned up`)
  }

  // Three runs created three Noise nodes historically, but none remain live.
  assert.equal(registry.byKind('Noise').length, 3)
  assert.equal(registry.live('Noise').length, 0)
})

test('sporadic timers are cleared on stop', async () => {
  // Short intervals so a sporadic fire happens during the test.
  intervalScale.factor = 0.02
  const { c, s } = newComponentWithSample({
    playbackMode: 'sporadic',
    sporadicMin: 1,
    sporadicMax: 1
  })

  await c.play()
  assert.equal(activeIntervalCount(), 1, 'initial sporadic interval registered')

  // Let the sporadic interval fire at least once; it swaps to sporadicInterval.
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.ok(s.sporadicInterval, 'playSporadicSample armed the follow-up interval')

  c.stop()
  assert.equal(activeIntervalCount(), 0, 'no JS interval may survive stop')
  assert.equal(s.initialSporadicPlayInterval, null)
  assert.equal(s.sporadicInterval, null)
  assert.equal(Transport.state, 'stopped')
})

test('timer-mode intervals are cleared on stop', async () => {
  const { c } = newComponentWithSample()
  c.isTimerEnabled = true
  c.hours = 0
  c.minutes = 0
  c.seconds = 30

  await c.play()
  assert.equal(activeIntervalCount(), 2, 'stop-at-duration + countdown intervals')
  assert.equal(Transport.loopEnd, 30)

  c.stop()
  assert.equal(activeIntervalCount(), 0)
  assert.equal(c.timeRemaining, 0)
  assert.equal(Transport.loopEnd, '4m', 'transport loop bounds reset')
})

test('slider update methods skip safely when nodes do not exist', () => {
  const c = makeComponent()
  // Nothing has been played: every graph reference is null. None of these may
  // throw, matching the requirement that updates on stale nodes be no-ops.
  assert.doesNotThrow(() => c.updateVolume())
  assert.doesNotThrow(() => c.updateNoiseColor())
  assert.doesNotThrow(() => c.updateFilterType())
  assert.doesNotThrow(() => c.updateFilterCutoff())
  assert.doesNotThrow(() => c.updateLFOFilterCutoffFrequency())
  assert.doesNotThrow(() => c.updateLFOFilterCutoffRange())
  assert.doesNotThrow(() => c.updateTremoloFrequency())
  assert.doesNotThrow(() => c.updateTremoloDepth())
  assert.doesNotThrow(() => c.updateAudioChain())
})

test('slider updates reach the live nodes and remain effective after replay', async () => {
  const { c } = newComponentWithSample()
  c.isFilterEnabled = true
  c.isTremoloEnabled = true
  c.isLFOFilterCutoffEnabled = true

  await c.play()
  c.volume = -25
  c.updateVolume()
  assert.equal(c.noise.volume.value, -25)

  c.filterCutoff = 4321
  c.updateFilterCutoff()
  assert.equal(c.filter.options.frequency, 4321)

  c.tremoloDepth = 0.9
  c.updateTremoloDepth()
  assert.equal(c.tremolo.options.depth, 0.9)

  c.lfoFilterCutoffFrequency = 2.5
  c.updateLFOFilterCutoffFrequency()
  assert.equal(c.lfo.options.frequency, 2.5)

  c.stop()
  await c.play()
  // The second run's fresh nodes inherit the current slider values.
  assert.equal(c.noise.volume.value, -25)
  assert.equal(c.filter.options.cutoff, 4321)
})

test('updateAudioChain rebuilds the sub-chain while keeping Noise alive', async () => {
  const c = makeComponent()
  await c.play()
  const originalNoise = c.noise

  c.isFilterEnabled = true
  c.updateAudioChain()

  assert.equal(c.noise, originalNoise, 'noise node is preserved across chain rewiring')
  assert.equal(registry.live('Filter').length, 1)
  assert.equal(registry.live('Noise').length, 1)

  // Old effects from a previous rewire must be disposed rather than stacked.
  c.isTremoloEnabled = true
  c.updateAudioChain()
  assert.equal(registry.live('Filter').length, 1)
  assert.equal(registry.live('Tremolo').length, 1)
  assert.equal(registry.live('Noise').length, 1)

  c.stop()
  assert.equal(registry.live('Noise').length, 0)
})

test('LFO is never created without a filter node', async () => {
  const c = makeComponent()
  // Defensive: LFO enabled checkbox while filter itself is off.
  c.isFilterEnabled = false
  c.isLFOFilterCutoffEnabled = true
  await c.play()
  assert.equal(c.lfo, null)
  assert.equal(registry.live('LFO').length, 0)
  c.stop()
})

test('recording routes nodes through the recorder and restores settings on stop', async () => {
  const { c, s } = newComponentWithSample()
  addPooledPlayer(c, s.id)

  // Simulate the live pre-recording configuration.
  c.volume = -7
  c.noiseColor = 'brown'
  c.isFilterEnabled = false
  c.loadedSamples = [s]
  c.activeProfile = { id: 9, name: 'Live' }
  c.unwatch = c.$watch('changeableSettings', () => { c.unsavedWork = true })
  c.preRecordingSnapshot = c.snapshotCurrentSettings()

  // Recording profile carries different settings.
  c.volume = -30
  c.noiseColor = 'white'
  c.loadedSamples = []

  await c.playProfileForRecording()
  assert.equal(c.isRecording, true)
  assert.equal(registry.live('Noise').length, 1)
  // Noise output routing must include the recorder.
  assert.ok(c.noise.connected.some(target => target === c.recorder))

  await c.recorder.start()
  assert.equal(c.recorder.state, 'started')
  c.recordingInterval = setInterval(() => {}, 1000)

  await c.stopRecording()

  assert.equal(c.recorder.state, 'stopped')
  assert.equal(registry.live('Noise').length, 0)
  assert.equal(activeIntervalCount(), 0, 'recording interval removed')
  assert.equal(c.volume, -7, 'pre-recording volume restored')
  assert.equal(c.noiseColor, 'brown', 'pre-recording noise color restored')
  assert.equal(c.loadedSamples.length, 1, 'pre-recording samples restored')
  assert.equal(c.activeProfile.id, 9)
  assert.equal(c.preRecordingSnapshot, null)
  assert.equal(c.recordingDialog, false)
  assert.equal(c.playDisabled, false)
})

test('cancelling recording stops recorder/timers and still restores settings', async () => {
  const { c } = newComponentWithSample()
  c.volume = -12
  c.activeProfile = { id: 3, name: 'Keep' }
  c.unwatch = c.$watch('changeableSettings', () => { c.unsavedWork = true })
  c.preRecordingSnapshot = c.snapshotCurrentSettings()

  c.volume = -50
  await c.playProfileForRecording()
  await c.recorder.start()
  c.recordingInterval = setInterval(() => {}, 1000)

  await c.cancelRecording()

  assert.equal(c.recorder.state, 'stopped')
  assert.equal(registry.live('Noise').length, 0)
  assert.equal(activeIntervalCount(), 0)
  assert.equal(c.volume, -12)
  assert.equal(c.activeProfile.id, 3)
  assert.equal(c.recordingDialog, false)
})

test('starting a recording releases the previous graph first', async () => {
  const { c } = newComponentWithSample()

  await c.play()
  const firstNoise = c.noise
  assert.equal(registry.live('Noise').length, 1)

  c.preRecordingSnapshot = c.snapshotCurrentSettings()
  await c.playProfileForRecording()

  assert.notEqual(c.noise, firstNoise)
  assert.equal(firstNoise.disposed, true, 'previous playback node disposed before recording graph')
  assert.equal(registry.live('Noise').length, 1, 'no node stacking across play -> record')
  c.stop()
})

test('stop() with no active graph is a safe no-op', () => {
  const c = makeComponent()
  assert.doesNotThrow(() => c.stop())
  assert.equal(c.playDisabled, false)
  assert.equal(Transport.state, 'stopped')
})

test('stop() is idempotent when called twice (timer auto-stop + manual stop)', async () => {
  const { c } = newComponentWithSample()
  c.isTimerEnabled = true
  c.seconds = 30

  await c.play()
  c.stop()
  // A second stop — e.g. the duration interval firing against an already
  // converged run — must not throw and must keep the graph empty.
  assert.doesNotThrow(() => c.stop())
  assert.equal(c.noise, null)
  assert.equal(registry.live('Noise').length, 0)
  assert.equal(activeIntervalCount(), 0)
  assert.equal(c.playDisabled, false)
})

test('beforeDestroy releases the run and disposes pooled resources', () => {
  const c = makeComponent()
  c.created()
  const { players, recorder, samplePreviewPlayer } = c
  c.beforeDestroy()
  assert.equal(players.disposed, true)
  assert.equal(recorder.disposed, true)
  assert.equal(samplePreviewPlayer.disposed, true)
})
