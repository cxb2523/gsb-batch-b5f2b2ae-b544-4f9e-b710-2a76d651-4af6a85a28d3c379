// PreviewPlayer's wiring: player events in, seeks/pauses/onEnded out.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PreviewController,
  type PreviewPlayerPort,
  createPreviewController,
} from '../../src/views/components/discover/previewController.js';

// A 60-second preview starting at 0:30 of a longer film.
const span = { startSec: 30, durationSec: 60 };

/** A stand-in for the Bitmovin player that records what it was asked to do. */
function fakePlayer() {
  const calls: string[] = [];
  const port: PreviewPlayerPort = {
    seek: (time, issuer) => calls.push(`seek ${time}${issuer ? ` (${issuer})` : ''}`),
    pause: issuer => calls.push(`pause${issuer ? ` (${issuer})` : ''}`),
    play: issuer => {
      calls.push(`play${issuer ? ` (${issuer})` : ''}`);
      return Promise.resolve();
    },
  };
  return { port, calls };
}

function setup() {
  const player = fakePlayer();
  const ended: string[] = [];
  const shown: string[] = [];
  const controller: PreviewController = createPreviewController({
    span,
    player: player.port,
    onChange: state => shown.push(`${state.phase}:${state.remaining}`),
    onEnded: () => ended.push('ended'),
  });
  return { ...player, controller, ended, shown };
}

/** Plays a stretch of positions, one second apart. */
function play(controller: PreviewController, from: number, to: number) {
  for (let t = from; t <= to; t++) {
    controller.time(t);
  }
}

describe('preview player: a normal pass', () => {
  it('pauses and reports one end when the window is reached', () => {
    const { controller, calls, ended } = setup();
    play(controller, 30, 89);
    assert.equal(controller.state.phase, 'playing');
    assert.deepEqual(ended, []);

    controller.time(90);
    assert.equal(controller.state.phase, 'ended');
    assert.deepEqual(ended, ['ended']);
    assert.deepEqual(calls, ['pause (api)']);
  });

  it('does not report a second end for positions after the end card', () => {
    const { controller, ended } = setup();
    play(controller, 30, 95);
    controller.finished();
    assert.deepEqual(ended, ['ended']);
  });

  it('shows the countdown falling as playback advances', () => {
    const { controller, shown } = setup();
    play(controller, 30, 32);
    assert.deepEqual(shown, ['playing:60', 'playing:59', 'playing:58']);
  });
});

describe('preview player: replay', () => {
  it('restarts the countdown at the full window and seeks back', () => {
    const { controller, calls, ended } = setup();
    play(controller, 30, 90);
    calls.length = 0;
    ended.length = 0;

    assert.equal(controller.replay(), true);
    assert.equal(controller.state.phase, 'playing');
    assert.equal(controller.state.remaining, 60);
    assert.deepEqual(calls, ['seek 30 (api)', 'play (api)']);
  });

  it('ignores the stale end position and the old stream finish until the seek lands', () => {
    const { controller, calls, ended } = setup();
    play(controller, 30, 90);
    controller.replay();
    calls.length = 0;

    // Positions from the end card still arrive while the seek back settles.
    controller.time(90);
    controller.time(88);
    controller.finished();
    assert.equal(controller.state.phase, 'playing');
    assert.deepEqual(ended, ['ended'], 'only the first pass reported an end');
    assert.deepEqual(calls, [], 'nothing was paused or sought again');
  });

  it('plays through again after a replay, reporting a second end', () => {
    const { controller, ended } = setup();
    play(controller, 30, 90);
    controller.replay();
    controller.seeked();
    // The seek lands just before the start; that is inside the window.
    controller.time(29.5);
    play(controller, 30, 89);
    assert.equal(controller.state.phase, 'playing');
    controller.time(90);
    assert.deepEqual(ended, ['ended', 'ended']);
  });

  it('does nothing when there is no end card to replay from', () => {
    const { controller, calls } = setup();
    play(controller, 30, 40);
    assert.equal(controller.replay(), false);
    assert.deepEqual(calls, []);
  });
});

describe('preview player: seeking', () => {
  it('sends playback back to the window start when the user seeks before it', () => {
    const { controller, calls } = setup();
    play(controller, 30, 60);
    calls.length = 0;

    controller.time(10);
    assert.deepEqual(calls, ['seek 30 (api)']);
    assert.equal(controller.state.remaining, 60);
  });

  it('does not seek again while the jump back settles', () => {
    const { controller, calls } = setup();
    play(controller, 30, 60);
    controller.time(10);
    calls.length = 0;
    controller.time(12);
    controller.time(40); // a position from the old spot, mid-seek
    assert.deepEqual(calls, []);
  });

  it('ends on a seek past the window the moment it is requested', () => {
    const { controller, ended } = setup();
    play(controller, 30, 40);
    controller.seek(120);
    assert.equal(controller.state.phase, 'ended');
    assert.deepEqual(ended, ['ended']);
  });

  it('keeps one continuous pass through repeated scrubbing inside the window', () => {
    const { controller, calls, ended } = setup();
    play(controller, 30, 60);
    calls.length = 0;
    for (const target of [40, 70, 50, 85, 45]) {
      controller.seek(target);
      controller.seeked();
      controller.time(target - 1);
    }
    assert.equal(controller.state.phase, 'playing');
    assert.deepEqual(ended, []);
    assert.deepEqual(calls, [], 'seeks inside the window are left to the player');
  });
});

describe('preview player: failure', () => {
  it('reports the failure once and ignores further playback', () => {
    const { controller, ended } = setup();
    play(controller, 30, 40);
    controller.fail();
    controller.fail();
    play(controller, 41, 90);
    assert.equal(controller.state.phase, 'error');
    assert.deepEqual(ended, []);
    assert.equal(controller.replay(), false);
  });
});
