import Oscillator from './Oscillator';
import Envelope from './Envelope';
import VCA from './VCA';
import param from '../helpers/param';
import applyParams from '../helpers/applyParams';

const ONE_MINUTE = 60;
const ONE_SECOND = 1000;

export default class Sequencer {
  defaults = {
    bpm: 120,
    steps: 16,
  }

  constructor(params = {}) {
    this.steps = 16;
    this.activeStep = 1;
    this.selectedStep = null;
    this.playing = false;
    this.recording = false;
    this.metronomeOn = true;
    this.sequenceTimestamp = null;
    this.sequence = null;
    this.sequenceGeneration = 0;
    this.stepTriggers = {};
    this.triggerCallbacks = [];
    this.onStepSelectCallbacks = [];
    this.onSetTriggerCallbacks = [];

    this.metronomeSteps = {
      1: 1000,
      5: 500,
      9: 500,
      13: 500,
    };

    this::applyParams(params);
    this.createMetronome();

    this.originalBpm = this.bpm;
  }

  createMetronome() {
    this.metronome = new Oscillator();
    this.metronomeEnvelope = new Envelope({
      sustain: 0.3,
      release: 0.2,
      peakLevel: 0.3,
    });

    this.metronomeVCA = new VCA();

    this.metronome.node.connect(this.metronomeVCA.node);
    this.metronomeEnvelope.modulate(this.metronomeVCA::param('gain'));

    this.metronome.setType('triangle');

    this.node = this.metronomeVCA.node;
  }

  setBpm(bpm) {
    this.bpm = bpm;

    if (this.playing) {
      this.rescheduleStep();
    }
  }

  setSteps(steps) {
    this.steps = steps;
  }

  setActiveStep(step) {
    this.activeStep = step;
  }

  setSelectedStep(step) {
    this.selectedStep = step;

    this.onStepSelectCallbacks.forEach(cb => cb());
  }

  onStepSelect(callback) {
    this.onStepSelectCallbacks.push(callback);
  }

  getStepInterval() {
    return ((ONE_MINUTE / this.bpm) / 4) * ONE_SECOND;
  }

  trigger(callback) {
    this.triggerCallbacks.push(callback);
  }

  triggerStep() {
    const stepTrigger = this.stepTriggers[this.activeStep];

    if (stepTrigger) {
      stepTrigger();
    }

    this.triggerCallbacks.forEach(cb => cb());
  }

  triggerMetronome() {
    const metronomeFrequency = this.metronomeSteps[this.activeStep % 16];

    if (this.metronomeOn && metronomeFrequency) {
      this.metronome.setFrequency(metronomeFrequency);
      this.metronomeEnvelope.trigger();
    }
  }

  triggerAtStep(step, callback) {
    if (step) {
      this.stepTriggers[step] = callback;
      this.onSetTriggerCallbacks.forEach(cb => cb());
    }
  }

  clearTriggerAtStep(step) {
    this.stepTriggers[step] = null;
  }

  quantizeStepTrigger() {
    if (this.selectedStep === null) {
      return null;
    }

    const interval = this.getStepInterval();
    const needsQuantize = this.sequenceTimestamp !== null
      && (Date.now() - this.sequenceTimestamp) > (interval / 2);

    if (this.recording && needsQuantize) {
      return this.selectedStep === this.steps ? 1 : this.selectedStep + 1;
    }

    return this.selectedStep;
  }

  triggerAtSelectedStep(callback) {
    const step = this.quantizeStepTrigger();

    this.triggerAtStep(step, callback);

    if (!this.recording) {
      this.selectedStep = null;
    }
  }

  onSetTrigger(callback) {
    this.onSetTriggerCallbacks.push(callback);
  }

  start() {
    // Ignore repeated calls while playing so a single set of step timers runs.
    if (this.playing) {
      return;
    }

    this.playing = true;
    this.sequenceGeneration += 1;

    // Playback resumes from the current active step; stop() resets it to 1.
    this.playStep(this.sequenceGeneration);
  }

  /**
   * Fire the callbacks for the current step and schedule the next one.
   * The step timestamp is recorded before user callbacks run so recording
   * always quantizes against the most recent real step time.
   */
  playStep(generation) {
    if (!this.playing || generation !== this.sequenceGeneration) {
      return;
    }

    this.sequenceTimestamp = Date.now();

    // Schedule first: callbacks may stop the sequencer (which cancels this
    // timer) or change the BPM (which reschedules it). Either way the timer is
    // owned by the current run only.
    this.scheduleNextStep(generation, this.getStepInterval());

    if (this.recording) {
      this.selectedStep = this.activeStep;
      this.triggerMetronome();
    }

    this.triggerStep();
  }

  advanceStep(generation) {
    if (!this.playing || generation !== this.sequenceGeneration) {
      return;
    }

    this.activeStep = this.activeStep >= this.steps ? 1 : this.activeStep + 1;
    this.playStep(generation);
  }

  scheduleNextStep(generation, interval) {
    this.cancelSequence();

    this.sequence = setTimeout(() => {
      this.advanceStep(generation);
    }, interval);
  }

  /**
   * Re-time the pending step after the BPM changed. The next step still fires
   * exactly once, using the new interval counted from the moment of the change.
   */
  rescheduleStep() {
    if (!this.playing) {
      return;
    }

    this.scheduleNextStep(this.sequenceGeneration, this.getStepInterval());
  }

  cancelSequence() {
    // The pending handle may come from setTimeout, but clearInterval and
    // clearTimeout share one id space in the browser and in Node, so a single
    // clear is enough and keeps the handle type an implementation detail.
    clearInterval(this.sequence);
  }

  stop() {
    this.playing = false;
    this.sequenceGeneration += 1;
    this.cancelSequence();
    this.activeStep = 1;
    this.selectedStep = null;
    // Drop the step timestamp so quantization after stopping cannot be based
    // on a step that is no longer running.
    this.sequenceTimestamp = null;
  }

  record() {
    this.recording = true;
  }

  stopRecord() {
    this.recording = false;
    this.selectedStep = null;
  }

  clearPattern() {
    this.stepTriggers = {};
    this.selectedStep = null;
  }

  setMetronomeStatus(status) {
    this.metronomeOn = status;
  }

  reset() {
    this.bpm = this.originalBpm;
    this.activeStep = 1;
    this.selectedStep = null;
    this.stepTriggers = {};
    this.sequenceTimestamp = null;
    this.triggerCallbacks = [];
    this.onStepSelectCallbacks = [];
    this.onSetTriggerCallbacks = [];

    this.stop();
    this.stopRecord();
  }
}
