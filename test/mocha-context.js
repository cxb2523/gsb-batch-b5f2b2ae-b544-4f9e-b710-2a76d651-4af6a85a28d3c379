/* Offline mocha tests for context-switch / note-table lifecycle of JZZ.synth.Tiny.
 * Runs with the headless node-web-audio-api implementation, so no browser is needed.
 * Assertions rely on deterministic engine state (the note table) and explicit
 * stop()/disconnect() call counts rather than GC or wall-clock timers.
 */
var assert = require('assert');
var WAAPI = require('node-web-audio-api');
var JZZ = require('jzz');
require('..')(JZZ);

global.window = { AudioContext: WAAPI.AudioContext, webkitAudioContext: WAAPI.AudioContext };
var _startTime = Date.now();
global.performance = { now: function() { return Date.now() - _startTime; } };

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

/* Wrap the node factories of an AudioContext so every explicit stop()/disconnect()
 * performed by the synth can be counted. */
function instrument(ac) {
  var stats = {
    oscCreated: 0, oscStopped: 0, oscDisconnected: 0,
    gainCreated: 0, gainDisconnected: 0,
    sourceCreated: 0, sourceStopped: 0
  };
  var origOsc = ac.createOscillator.bind(ac);
  ac.createOscillator = function() {
    var o = origOsc();
    stats.oscCreated++;
    var stop = o.stop.bind(o);
    o.stop = function(t) { stats.oscStopped++; return stop(t); };
    var disc = o.disconnect.bind(o);
    o.disconnect = function() { stats.oscDisconnected++; return disc.apply(o, arguments); };
    return o;
  };
  var origGain = ac.createGain.bind(ac);
  ac.createGain = function() {
    var g = origGain();
    stats.gainCreated++;
    var disc = g.disconnect.bind(g);
    g.disconnect = function() { stats.gainDisconnected++; return disc.apply(g, arguments); };
    return g;
  };
  var origSource = ac.createBufferSource.bind(ac);
  ac.createBufferSource = function() {
    var s = origSource();
    stats.sourceCreated++;
    var stop = s.stop.bind(s);
    s.stop = function(t) { stats.sourceStopped++; return stop(t); };
    return s;
  };
  return stats;
}

/* Build a synth wired to a fresh, instrumented context and return both. */
function makeSynth(opt) {
  var ac = new WAAPI.AudioContext();
  var stats = instrument(ac);
  var synth = new JZZ.synth.Tiny.WebAudioTinySynth(opt);
  synth.setAudioContext(ac);
  return { ac: ac, stats: stats, synth: synth };
}

var contexts = [];
after(function() {
  return Promise.all(contexts.map(function(ac) {
    return ac.close().catch(function() {});
  }));
});

describe('JZZ.synth.Tiny context lifecycle', function() {
  this.timeout(20000);

  it('reopening a same-name port stops and removes the old sounding notes', function() {
    var ac1 = JZZ.lib.getAudioContext();
    var s1 = instrument(ac1);

    JZZ.synth.Tiny.register('reopen-port');
    var port1 = JZZ().openMidiOut('reopen-port');
    return sleep(30).then(function() {
      // two sustained notes on the first context (each piano note = 2 oscillators)
      port1.noteOn(0, 60, 127);
      port1.noteOn(0, 64, 127);
      return sleep(40);
    }).then(function() {
      var voiceOsc = s1.oscCreated - 1; // exclude the LFO
      assert.ok(voiceOsc >= 4, 'notes must create oscillators on the first context');

      // reopening the same-named port reuses the synth but rebuilds its graph:
      // every old voice must be stopped and disconnected first
      var port2 = JZZ().openMidiOut('reopen-port');
      return sleep(40).then(function() { return { port2: port2, voiceOsc: voiceOsc }; });
    }).then(function(ctx) {
      assert.ok(s1.oscStopped >= ctx.voiceOsc,
        'all old note oscillators must be stopped when the port is reopened');
      assert.ok(s1.oscDisconnected >= ctx.voiceOsc,
        'all old note oscillators must be disconnected on reopen');
      assert.ok(s1.gainDisconnected >= ctx.voiceOsc,
        'all old note gain nodes must be disconnected on reopen');

      // the reused instance must still voice and release fresh notes
      var created = s1.oscCreated;
      ctx.port2.noteOn(0, 72, 100);
      return sleep(30).then(function() {
        assert.ok(s1.oscCreated > created, 'new notes must create fresh oscillators');
        assert.doesNotThrow(function() { ctx.port2.noteOff(0, 72); });
      });
    });
  });

  it('plug() moves the synth to another context and leaves no notes behind', function() {
    var env = makeSynth({ useReverb: 0 });
    var ac1 = env.ac, s1 = env.stats, synth = env.synth;
    contexts.push(ac1);
    var ac2 = new WAAPI.AudioContext();
    contexts.push(ac2);
    var s2 = instrument(ac2);

    synth.noteOn(0, 60, 127);
    synth.noteOn(0, 67, 110);
    assert.equal(synth.notetab.length, 2, 'two notes must be tracked on the old context');
    var oldVoiceOsc = s1.oscCreated - 1; // exclude the LFO
    assert.ok(oldVoiceOsc >= 2);

    synth.setAudioContext(ac2, ac2.createGain());

    // old context: voices and the shared LFO stopped, voices disconnected
    assert.ok(s1.oscStopped >= oldVoiceOsc + 1,
      'old voices and the old LFO must be stopped when switching contexts');
    assert.ok(s1.oscDisconnected >= oldVoiceOsc,
      'old voice oscillators must be disconnected from the old graph');
    // nothing from the old context survives in the note table
    assert.equal(synth.notetab.length, 0, 'the new context must not inherit old notes');
    assert.equal(synth.getAudioContext(), ac2, 'the synth must report the new context');

    // new context got its own LFO and channel chain
    assert.ok(s2.oscCreated >= 1, 'a new LFO must be created on the new context');
  });

  it('port.plug() routes output through a node on another AudioContext', function() {
    var ac1 = JZZ.lib.getAudioContext();
    instrument(ac1);
    var ac2 = new WAAPI.AudioContext();
    contexts.push(ac2);
    var s2 = instrument(ac2);

    JZZ.synth.Tiny.register('plug-node-port');
    var port = JZZ().openMidiOut('plug-node-port');
    return sleep(30).then(function() {
      assert.doesNotThrow(function() { port.plug(ac2.createGain()); });
      return sleep(30);
    }).then(function() {
      assert.ok(s2.oscCreated >= 1, 'plug must build the graph on the node context');

      // the engine itself accepts a raw context and safely falls back to its
      // destination instead of trying to connect() to the context object
      var ac3 = new WAAPI.AudioContext();
      var s3 = instrument(ac3);
      var engine = new JZZ.synth.Tiny.WebAudioTinySynth({ useReverb: 0 });
      assert.doesNotThrow(function() { engine.setAudioContext(ac3, ac3); });
      assert.equal(engine.getAudioContext(), ac3);
      assert.ok(s3.oscCreated >= 1, 'a raw-context destination must fall back to ac.destination');
      return ac3.close();
    });
  });

  it('notes triggered after a plug sound on the new context and release on noteOff', function() {
    var env = makeSynth({ useReverb: 0 });
    var ac1 = env.ac, synth = env.synth;
    contexts.push(ac1);
    var ac2 = new WAAPI.AudioContext();
    contexts.push(ac2);
    var s2 = instrument(ac2);

    synth.noteOn(0, 60, 127);
    synth.setAudioContext(ac2);
    assert.equal(synth.notetab.length, 0);

    // fresh note on the new context
    synth.noteOn(0, 62, 120);
    assert.equal(synth.notetab.length, 1, 'the new note must be tracked on the new context');
    assert.equal(synth.notetab[0].n, 62);
    var oscAfterNoteOn = s2.oscCreated;
    assert.ok(oscAfterNoteOn > 1, 'the new note must create oscillators on the new context');

    // releasing it marks the note and schedules the release tail
    synth.noteOff(0, 62);
    assert.equal(synth.notetab[0].f, 1, 'noteOff must mark the note released');
    assert.ok(synth.notetab[0].e > ac2.currentTime, 'the release end time must be scheduled');
    assert.equal(s2.oscCreated, oscAfterNoteOn, 'noteOff must not create new nodes');

    // a second noteOn/noteOff cycle must still work on the new context
    synth.noteOn(0, 65, 90);
    assert.equal(synth.notetab.length, 2);
    synth.noteOff(0, 65);
    assert.equal(synth.notetab[1].f, 1);

    // controllers after the switch must apply without touching stopped old nodes
    assert.doesNotThrow(function() {
      synth.setBend(0, 9000);
      synth.setChVol(0, 80);
      synth.setSustain(0, 100);
      synth.setSustain(0, 0);
      synth.allSoundOff(0);
      synth.reset();
    });
    assert.equal(synth.notetab.length, 0);
  });

  it('invalid plug()/setAudioContext() arguments keep the original chain usable', function() {
    var env = makeSynth({ useReverb: 0 });
    var ac1 = env.ac, s1 = env.stats, synth = env.synth;
    contexts.push(ac1);

    var before = s1.oscCreated;
    assert.doesNotThrow(function() {
      synth.setAudioContext(null);
      synth.setAudioContext(undefined);
      synth.setAudioContext({});
      synth.setAudioContext('dummy');
      synth.setAudioContext({ createGain: function() {} });
    });
    assert.equal(synth.getAudioContext(), ac1, 'the old context must remain in place');
    assert.equal(s1.oscCreated, before, 'invalid context must not rebuild the graph');

    // the port-level plug must reject the same bad inputs without throwing
    JZZ.synth.Tiny.register('invalid-plug-port');
    var port = JZZ().openMidiOut('invalid-plug-port');
    return sleep(20).then(function() {
      assert.doesNotThrow(function() {
        port.plug();
        port.plug(null);
        port.plug({});
        port.plug({ context: 'dummy' });
        port.plug({ context: null });
        port.plug({ context: { createGain: function() {} } });
      });

      // the original chain still voices and releases notes
      synth.noteOn(0, 60, 127);
      assert.equal(synth.notetab.length, 1);
      assert.ok(s1.oscCreated > before, 'the original context must still sound notes');
      synth.noteOff(0, 60);
      assert.equal(synth.notetab[0].f, 1, 'notes on the preserved context must release');
    });
  });

  it('allSoundOff/reset converge to an empty note table without dangling nodes', function() {
    var env = makeSynth({ useReverb: 0 });
    contexts.push(env.ac);
    var s1 = env.stats, synth = env.synth;

    synth.noteOn(1, 60, 127);
    synth.noteOn(1, 64, 127);
    synth.noteOn(2, 67, 127);
    assert.equal(synth.notetab.length, 3);
    var stoppedBefore = s1.oscStopped;

    synth.allSoundOff(1);
    assert.equal(synth.notetab.length, 1, 'only the channel-2 note may remain');
    assert.equal(synth.notetab[0].ch, 2);
    assert.ok(s1.oscStopped > stoppedBefore, 'allSoundOff must stop the channel nodes');

    // controllers are reset to predictable GM defaults, not carried over
    synth.setSustain(0, 100);
    synth.setBend(0, 9000);
    synth.setChVol(0, 20);
    synth.reset();
    assert.equal(synth.notetab.length, 0, 'reset must empty the note table');
    assert.equal(synth.sustain[0], 0, 'sustain must be reset');
    assert.equal(synth.bend[0], 0, 'pitch bend must be reset');
    assert.ok(synth.vol[0] > 0, 'channel volume must return to its default');
    assert.equal(synth.pg[0], 0, 'program must return to 0');

    // after reset the synth still plays and releases normally
    synth.noteOn(0, 60, 127);
    assert.equal(synth.notetab.length, 1);
    synth.noteOff(0, 60);
    assert.equal(synth.notetab[0].f, 1);
    synth.allSoundOff(0);
    assert.equal(synth.notetab.length, 0);
  });

  it('the periodic cleanup only removes released notes and never sounding ones', function() {
    var env = makeSynth({ useReverb: 0 });
    contexts.push(env.ac);
    var synth = env.synth;

    // one sustained note and one note whose release tail has fully elapsed
    synth.noteOn(0, 60, 127);
    synth.noteOn(0, 72, 127);
    synth.noteOff(0, 72);
    var released = synth.notetab.filter(function(nt) { return nt.n === 72; })[0];
    released.e = synth.actx.currentTime - 0.01; // simulate an expired release tail

    // run the same cleanup pass the 60ms timer performs
    for (var i = synth.notetab.length - 1; i >= 0; --i) {
      var nt = synth.notetab[i];
      if (synth.actx.currentTime > nt.e) {
        synth._pruneNote(nt);
        synth.notetab.splice(i, 1);
      }
    }
    assert.equal(synth.notetab.length, 1, 'only the expired released note is removed');
    assert.equal(synth.notetab[0].n, 60);
    assert.equal(synth.notetab[0].f, 0, 'the sounding note must be untouched');

    // a sounding note (e == 99999) can never be time-pruned
    assert.equal(synth.notetab[0].e, 99999);
    synth.noteOff(0, 60);
    assert.equal(synth.notetab[0].f, 1);
    assert.ok(synth.notetab[0].e < 90000, 'noteOff must schedule a finite release tail');
  });

  it('_limitVoices never drops a sounding note while releasable voices exist', function() {
    var env = makeSynth({ voices: 4, useReverb: 0 });
    contexts.push(env.ac);
    var s = env.stats, synth = env.synth;

    // four sounding notes fill the table up to the cap
    synth.noteOn(0, 60, 127);
    synth.noteOn(0, 62, 127);
    synth.noteOn(0, 64, 127);
    synth.noteOn(0, 65, 127);
    assert.equal(synth.notetab.length, 4);
    assert.ok(synth.notetab.every(function(nt) { return nt.f === 0; }));

    // release one: it stays in the table with f==1 and a pending release tail
    synth.noteOff(0, 60);
    assert.equal(synth.notetab.length, 4);

    // a fifth note forces voice stealing: the released voice (60) goes first
    synth.noteOn(0, 67, 127);
    assert.equal(synth.notetab.length, 4, 'voice count must stay at the cap');
    assert.ok(!synth.notetab.some(function(nt) { return nt.n === 60; }),
      'the released note must be stolen before any still-sounding note');
    assert.deepEqual(synth.notetab.map(function(nt) { return nt.n; }).sort(),
      [62, 64, 65, 67], 'all three sounding notes must survive the steal');
    assert.ok(s.oscStopped > 0, 'the stolen voice must have its oscillators stopped');

    // once all voices are sounding, stealing still works without throwing
    assert.doesNotThrow(function() { synth.noteOn(0, 69, 127); });
    assert.equal(synth.notetab.length, 4);
    assert.ok(synth.notetab.every(function(nt) { return nt.f === 0; }),
      'only sounding notes remain, all still playable');
    synth.allSoundOff(0);
    assert.equal(synth.notetab.length, 0);
  });

  it('sustain state does not leak across a context switch', function() {
    var env = makeSynth({ useReverb: 0 });
    contexts.push(env.ac);
    var ac2 = new WAAPI.AudioContext();
    contexts.push(ac2);
    var synth = env.synth;

    // damper down, note played and released: it must stay pending in the table
    synth.setSustain(0, 100);
    synth.noteOn(0, 60, 127);
    synth.noteOff(0, 60);
    assert.equal(synth.notetab[0].f, 1, 'the key is released...');
    assert.equal(synth.notetab[0].e, 99999, '...but the pedal keeps the voice sounding');

    synth.setAudioContext(ac2);
    assert.equal(synth.sustain[0], 0, 'the new context starts with the damper up');
    assert.equal(synth.notetab.length, 0);

    // a note released after the switch really enters release, no inherited pedal
    synth.noteOn(0, 60, 127);
    synth.noteOff(0, 60);
    assert.equal(synth.notetab[0].f, 1);
    assert.ok(synth.notetab[0].e < 90000, 'released note must schedule a finite tail');
  });
});
