// The Trailer Reel's sequencing: cards, beats, manual picks and the failure limit.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ReelState,
  MAX_FAILURES_IN_A_ROW,
  initialReelState,
  reelReducer,
  shouldAdvance,
} from '../../src/views/components/discover/reelState.js';

const FILMS = 4; // enough to hit the failure limit and still have somewhere to go

/** Applies actions in order. */
function run(state: ReelState, ...actions: Parameters<typeof reelReducer>[1][]): ReelState {
  return actions.reduce(reelReducer, state);
}

/** The beat the reel would arm right now, and whether it would move on. */
function armed(state: ReelState, films = FILMS): boolean {
  return shouldAdvance(state, films);
}

describe('trailer reel: normal advance', () => {
  it('waits on the end card, then moves to the next preview', () => {
    let s = run(initialReelState, { type: 'ended' });
    assert.equal(s.waiting, true);
    assert.equal(armed(s), true);
    s = run(s, { type: 'advance', from: 0, count: FILMS });
    assert.equal(s.index, 1);
    assert.equal(s.waiting, false);
  });

  it('never advances past the last preview', () => {
    let s: ReelState = { ...initialReelState, index: FILMS - 1 };
    s = run(s, { type: 'ended' });
    assert.equal(armed(s), false);
    assert.equal(run(s, { type: 'advance', from: FILMS - 1, count: FILMS }).index, FILMS - 1);
  });

  it('does not advance until the card is up', () => {
    assert.equal(armed(initialReelState), false);
  });
});

describe('trailer reel: stale beats', () => {
  it('ignores a beat armed for a preview that is no longer current', () => {
    // A beat armed for preview 0 fires after the user picked preview 2.
    const picked = run(initialReelState, { type: 'select', index: 2 });
    const late = run(picked, { type: 'advance', from: 0, count: FILMS });
    assert.equal(late.index, 2, 'the stale beat must not push the new preview away');
    assert.equal(late.waiting, false);
  });

  it('ignores a beat after a replay cancelled it', () => {
    const replayed = run(initialReelState, { type: 'ended' }, { type: 'replay' });
    assert.equal(replayed.waiting, false);
    const late = run(replayed, { type: 'advance', from: 0, count: FILMS });
    assert.equal(late.index, 0);
    assert.equal(late.waiting, false);
  });

  it('ignores a beat after auto-advance was switched off', () => {
    const off = run(initialReelState, { type: 'ended' }, { type: 'auto', on: false });
    assert.equal(armed(off), false);
    assert.equal(run(off, { type: 'advance', from: 0, count: FILMS }).index, 0);
  });

  it('ignores a beat for a preview that has moved on, even if it is somehow re-armed', () => {
    const moved = run(initialReelState, { type: 'ended' }, { type: 'advance', from: 0, count: FILMS });
    // Preview 1 is playing, no card up: nothing may advance.
    assert.equal(armed(moved), false);
    assert.equal(run(moved, { type: 'advance', from: 1, count: FILMS }).index, 1);
  });
});

describe('trailer reel: failures', () => {
  it('counts failures in a row and stops after the limit', () => {
    let s = initialReelState;
    for (let i = 0; i < MAX_FAILURES_IN_A_ROW; i++) {
      s = run(s, { type: 'error' });
      assert.equal(s.waiting, true);
      if (i < MAX_FAILURES_IN_A_ROW - 1) {
        assert.equal(armed(s), true, `still advancing after ${i + 1} failures`);
        s = run(s, { type: 'advance', from: s.index, count: FILMS });
      }
    }
    assert.equal(s.failures, MAX_FAILURES_IN_A_ROW);
    assert.equal(armed(s), false, 'the reel stops after three failures in a row');
    // The beat that would have been armed must not move it either.
    assert.equal(run(s, { type: 'advance', from: s.index, count: FILMS }).index, s.index);
  });

  it('counts one failure per preview, however many error signals it sends', () => {
    const s = run(initialReelState, { type: 'error' }, { type: 'error' }, { type: 'error' });
    assert.equal(s.failures, 1);
    assert.equal(s.waiting, true);
  });

  it('breaks the streak when a preview plays through', () => {
    const s = run(
      initialReelState,
      { type: 'error' },
      { type: 'advance', from: 0, count: FILMS },
      { type: 'error' },
      { type: 'advance', from: 1, count: FILMS },
      { type: 'ended' },
    );
    assert.equal(s.failures, 0);
    assert.equal(armed(s), true);
  });

  it('starts counting afresh when the user picks a preview', () => {
    const s = run(
      initialReelState,
      { type: 'error' },
      { type: 'advance', from: 0, count: FILMS },
      { type: 'error' },
      { type: 'select', index: 3 },
      { type: 'error' },
    );
    assert.equal(s.failures, 1);
    assert.equal(s.waiting, true);
    assert.equal(armed(s), false, 'it is the last preview, so there is nowhere to go');
  });

  it('stops scheduling once the failure limit is reached even if auto is toggled', () => {
    let s = initialReelState;
    for (let i = 0; i < MAX_FAILURES_IN_A_ROW; i++) {
      s = run(s, { type: 'error' });
      if (i < MAX_FAILURES_IN_A_ROW - 1) {
        s = run(s, { type: 'advance', from: s.index, count: FILMS });
      }
    }
    s = run(s, { type: 'auto', on: false }, { type: 'auto', on: true });
    assert.equal(armed(s), false);
  });
});

describe('trailer reel: user actions', () => {
  it('moves on a manual pick and clears the card', () => {
    const s = run(initialReelState, { type: 'ended' }, { type: 'select', index: 2 });
    assert.equal(s.index, 2);
    assert.equal(s.waiting, false);
    assert.equal(armed(s), false, 'the previous beat is void, not re-armed for the new preview');
  });

  it('does nothing when picking the preview already playing', () => {
    const ended = run(initialReelState, { type: 'ended' });
    assert.equal(run(ended, { type: 'select', index: 0 }), ended);
  });

  it('re-arms auto-advance when switched back on with a card up', () => {
    let s = run(initialReelState, { type: 'ended' }, { type: 'auto', on: false });
    assert.equal(armed(s), false);
    s = run(s, { type: 'auto', on: true });
    assert.equal(armed(s), true);
  });
});
