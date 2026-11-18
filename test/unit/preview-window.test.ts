// The preview window's rules, as PreviewPlayer drives them from player events.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PreviewWindowState,
  initialPreviewState,
  onSeekSettled,
  onSeekTarget,
  onTime,
  onWindowEnded,
  onWindowError,
  onWindowReplay,
} from '../../src/views/components/discover/previewWindow.js';

// A 60-second preview starting at 0:30 of a longer film.
const span = { startSec: 30, durationSec: 60 };

/** Runs a burst of playback positions, as the player would report them, returning the last state. */
function play(state: PreviewWindowState, from: number, to: number, step = 1): PreviewWindowState {
  let s = state;
  for (let t = from; t <= to; t += step) {
    s = onTime(s, span, t).state;
  }
  return s;
}

/** What the player would be told to do, if anything. */
const seekOf = (update: { seekTo?: number }) => update.seekTo;

describe('preview window: a normal pass', () => {
  it('ignores the start-up positions before the offset applies, then counts down', () => {
    let s = initialPreviewState(span);
    s = onTime(s, span, 0).state; // the player reports position 0 before the start offset applies
    assert.equal(s.phase, 'playing');
    assert.equal(s.remaining, 60);

    s = onTime(s, span, 30).state;
    assert.equal(s.remaining, 60);
    s = onTime(s, span, 45).state;
    assert.equal(s.remaining, 45);
  });

  it('ends exactly at the window end, clearing the countdown', () => {
    let s = play(initialPreviewState(span), 30, 89);
    assert.equal(s.phase, 'playing');
    assert.equal(s.remaining, 1);

    s = onTime(s, span, 90).state;
    assert.equal(s.phase, 'ended');
    assert.equal(s.remaining, 0);
  });

  it('keeps ended through further positions, so the card is not re-reported', () => {
    const ended = play(initialPreviewState(span), 30, 90);
    assert.deepEqual(onTime(ended, span, 95).state, ended);
    assert.deepEqual(onWindowEnded(ended).state, ended, 'a second finish changes nothing');
  });

  it('ends the preview when the stream itself finishes', () => {
    const s = play(initialPreviewState(span), 30, 50);
    const update = onWindowEnded(s);
    assert.equal(update.state.phase, 'ended');
    assert.equal(update.state.remaining, 0);
  });
});

describe('preview window: replay', () => {
  it('re-arms at the start with the full countdown and a seek back', () => {
    const ended = play(initialPreviewState(span), 30, 90);
    const replay = onWindowReplay(ended, span);
    assert.equal(replay.state.phase, 'playing');
    assert.equal(replay.state.remaining, 60, 'the countdown must not stay at zero');
    assert.equal(seekOf(replay), 30);
  });

  it('does not end on the stale end position the player still reports after replay', () => {
    const ended = play(initialPreviewState(span), 30, 90);
    let s = onWindowReplay(ended, span).state;
    // The old position from the end card arrives before the seek lands.
    for (const stale of [90, 91, 92]) {
      const update = onTime(s, span, stale);
      assert.equal(update.state.phase, 'playing', `must not end on stale position ${stale}`);
      assert.equal(seekOf(update), undefined, 'must not seek again');
      s = update.state;
    }
    // Nor may the stream's "finished" event from the old pass end the new one.
    assert.equal(onWindowEnded(s).state.phase, 'playing');
  });

  it('plays through again after a replay, reporting a second end', () => {
    const ended = play(initialPreviewState(span), 30, 90);
    let s = onWindowReplay(ended, span).state;
    s = onSeekSettled(s, span);
    // Keyframes land a hair early: still inside the window, never another seek.
    s = onTime(s, span, 29.2).state;
    assert.equal(s.phase, 'playing');
    s = play(s, 30, 89);
    assert.equal(s.phase, 'playing');
    assert.equal(onTime(s, span, 90).state.phase, 'ended', 'a replay pass ends again');
  });

  it('ignores replay requests unless the preview is on its end card', () => {
    const playing = play(initialPreviewState(span), 30, 40);
    assert.deepEqual(onWindowReplay(playing, span).state, playing);
  });
});

describe('preview window: seeking', () => {
  it('jumps back to the start when the user seeks before the window', () => {
    let s = play(initialPreviewState(span), 30, 60);
    const back = onTime(s, span, 10);
    assert.equal(seekOf(back), 30, 'the player is sent back to the window start');
    assert.equal(back.state.remaining, 60);
    assert.equal(back.state.phase, 'playing');
    s = back.state;

    // Positions from before the seek are stale and must not trigger more seeks.
    for (const stale of [10, 15, 20, 28]) {
      const update = onTime(s, span, stale);
      assert.equal(seekOf(update), undefined, `stale position ${stale} must not seek again`);
      assert.equal(update.state.phase, 'playing');
      s = update.state;
    }
  });

  it('resumes the countdown from the window start once the seek back lands', () => {
    let s = onTime(play(initialPreviewState(span), 30, 60), span, 10).state;
    s = onSeekSettled(s, span);
    s = onTime(s, span, 31).state;
    assert.equal(s.phase, 'playing');
    assert.equal(s.remaining, 59);
  });

  it('does not end on a stale position past the window while the seek back settles', () => {
    let s = onTime(play(initialPreviewState(span), 30, 60), span, 10).state;
    // A decoder position from the old (later) spot arrives mid-seek.
    const update = onTime(s, span, 200);
    assert.equal(update.state.phase, 'playing');
    s = update.state;
    assert.equal(onWindowEnded(s).state.phase, 'playing', 'nor may the old stream end end it');
  });

  it('ends the preview when the user seeks past the window', () => {
    const s = play(initialPreviewState(span), 30, 40);
    const update = onSeekTarget(s, span, 200);
    assert.equal(update.state.phase, 'ended');
    assert.equal(update.state.remaining, 0);
  });

  it('ends the preview as soon as the seek target is past the window, before playback gets there', () => {
    const update = onSeekTarget(play(initialPreviewState(span), 30, 40), span, 90);
    assert.equal(update.state.phase, 'ended');
  });

  it('sends a seek before the window back to its start without a second seek per target', () => {
    const s = play(initialPreviewState(span), 30, 60);
    const first = onSeekTarget(s, span, 5);
    assert.equal(seekOf(first), 30);
    assert.equal(seekOf(onSeekTarget(first.state, span, 5)), undefined, 'the same target does not pile up seeks');
  });

  it('follows repeated scrubbing inside the window without ending early', () => {
    let s = play(initialPreviewState(span), 30, 60);
    for (const target of [40, 70, 50, 85, 45]) {
      const update = onSeekTarget(s, span, target);
      assert.equal(update.state.phase, 'playing');
      assert.equal(update.state.remaining, 30 + 60 - target, `countdown follows the target ${target}`);
      s = onSeekSettled(update.state, span);
      // The player reports a little before/after the target, never a jump.
      s = onTime(s, span, target - 1).state;
    }
    assert.equal(s.phase, 'playing');
  });

  it('a scrub back inside the window cannot end the preview from a stale position from the old spot', () => {
    let s = play(initialPreviewState(span), 30, 85);
    s = onSeekTarget(s, span, 40).state; // scrub from 85 to 40: the seek is in flight
    const stale = onTime(s, span, 85); // the player still reports the old spot
    assert.equal(stale.state.phase, 'playing');
    s = onSeekSettled(stale.state, span);
    assert.equal(s.remaining, 50, 'the countdown is the target’s, not the old spot’s');
  });
});

describe('preview window: failure', () => {
  it('stops responding to playback once failed', () => {
    const failed = onWindowError(play(initialPreviewState(span), 30, 40));
    assert.equal(failed.phase, 'error');
    assert.equal(onTime(failed, span, 90).state.phase, 'error');
    assert.equal(onWindowReplay(failed, span).state.phase, 'error');
  });
});
