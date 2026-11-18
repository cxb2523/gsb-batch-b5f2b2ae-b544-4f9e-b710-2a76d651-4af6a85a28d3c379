// Client-side behavior tests for <Agent3D>: iframe lifecycle, postMessage
// ownership across reloads, and the onLoad/onError convergence contract.
//
// These run in jsdom (see ./dom-helpers.mjs) because effects and iframes do
// not exist under react-dom/server. The embed player is simulated by
// dispatching MessageEvents on the host window with the iframe contentWindow
// as event.source — exactly what a real cross-origin frame produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { Agent3D, WalkEmbed } from '../dist/index.mjs';
import { mount, spyOnOutbound, React as ReactNS } from './dom-helpers.mjs';

const ORIGIN = 'https://three.ws';

/** Walk:ready message as the player sends it. */
const READY = { type: 'walk:ready' };

test('walk:ready from the current frame fires onLoad exactly once; duplicates are ignored', () => {
  const onLoad = [];
  const app = mount(Agent3D, { agentId: 'ag-1', onLoad: () => onLoad.push('ready') });

  app.postFrom(app.iframe().contentWindow, READY);
  assert.deepEqual(onLoad, ['ready']);

  // A chatty player re-announcing readiness must not re-fire the callback.
  app.postFrom(app.iframe().contentWindow, READY);
  app.postFrom(app.iframe().contentWindow, READY);
  assert.deepEqual(onLoad, ['ready'], 'onLoad may fire only once per loaded scene');

  app.unmount();
});

test('speed is pushed to the current frame only after it is ready, and only once', () => {
  const app = mount(Agent3D, { agentId: 'ag-1', speed: 1.5 });
  const outbound = spyOnOutbound(app.iframe());

  // Before readiness, nothing is sent even if unrelated events arrive.
  app.postFrom(app.iframe().contentWindow, { type: 'walk:someEvent' });
  assert.equal(outbound.length, 0);

  app.postFrom(app.iframe().contentWindow, READY);
  assert.equal(outbound.length, 1);
  assert.deepEqual(outbound[0].message, { type: 'walk:config', speed: 1.5 });
  assert.equal(outbound[0].targetOrigin, ORIGIN);

  // Duplicate ready messages must not re-push the config.
  app.postFrom(app.iframe().contentWindow, READY);
  assert.equal(outbound.length, 1);

  outbound.restore();
  app.unmount();
});

test('no speed is posted when the speed prop is absent', () => {
  const app = mount(Agent3D, { agentId: 'ag-1' });
  const outbound = spyOnOutbound(app.iframe());

  app.postFrom(app.iframe().contentWindow, READY);
  assert.equal(outbound.length, 0);

  outbound.restore();
  app.unmount();
});

test('walk:error from the current frame fires onError with an Error, once per event', () => {
  const errors = [];
  const app = mount(Agent3D, { agentId: 'ag-1', onError: (err) => errors.push(err) });

  app.postFrom(app.iframe().contentWindow, { type: 'walk:error', error: 'boom' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.equal(errors[0].message, 'boom');

  // A bare error event falls back to the generic message.
  app.postFrom(app.iframe().contentWindow, { type: 'walk:error' });
  assert.equal(errors.length, 2);
  assert.equal(errors[1].message, 'three.ws embed failed to load');

  app.unmount();
});

test('origin validation is preserved: messages from other origins are rejected', () => {
  const onLoad = [];
  const onError = [];
  const app = mount(Agent3D, {
    agentId: 'ag-1',
    onLoad: () => onLoad.push(1),
    onError: (e) => onError.push(e),
  });
  const win = app.iframe().contentWindow;

  app.postFrom(win, READY, 'https://evil.example.com');
  app.postFrom(win, { type: 'walk:error', error: 'x' }, 'http://three.ws.evil.test');
  assert.deepEqual(onLoad, []);
  assert.deepEqual(onError, []);

  // The legit origin still works.
  app.postFrom(win, READY, ORIGIN);
  assert.deepEqual(onLoad, [1]);

  app.unmount();
});

test('messages with a foreign source are rejected even when the origin matches', () => {
  const onLoad = [];
  const app = mount(Agent3D, { agentId: 'ag-1', onLoad: () => onLoad.push(1) });
  const foreignWindow = { postMessage() {} };
  const anotherWindow = { postMessage() {} };

  app.postFrom(foreignWindow, READY);
  app.postFrom(anotherWindow, READY);
  assert.deepEqual(onLoad, []);

  app.unmount();
});

test('changing an embed-address prop remounts the iframe and resets the readiness latch', () => {
  const onLoad = [];
  const app = mount(Agent3D, { agentId: 'ag-1', onLoad: () => onLoad.push(1) });
  const firstIframe = app.iframe();

  app.postFrom(firstIframe.contentWindow, READY);
  assert.deepEqual(onLoad, [1]);

  // agentId feeds the avatar query param → new src → fresh iframe element.
  app.rerender({ agentId: 'ag-2' });
  const secondIframe = app.iframe();
  assert.notEqual(secondIframe, firstIframe, 'a new src must remount the iframe');
  assert.notEqual(secondIframe.contentWindow, firstIframe.contentWindow);
  assert.ok(!firstIframe.isConnected, 'the old iframe is removed from the DOM');
  assert.deepEqual(onLoad, [1], 'reloading must not fire onLoad by itself');

  app.unmount();
});

test('a late walk:ready from the unloaded frame is ignored after a reload', () => {
  const onLoad = [];
  const app = mount(Agent3D, { agentId: 'ag-1', onLoad: () => onLoad.push(1) });
  const oldWindow = app.iframe().contentWindow;

  app.rerender({ agentId: 'ag-2' });
  const newWindow = app.iframe().contentWindow;

  // The old scene finishes loading only after the iframe was replaced.
  app.postFrom(oldWindow, READY);
  app.postFrom(oldWindow, READY);
  assert.deepEqual(onLoad, [], 'stale ready messages must never fire onLoad');

  // The current scene's ready is the one that counts, exactly once.
  app.postFrom(newWindow, READY);
  assert.deepEqual(onLoad, [1]);
  app.postFrom(newWindow, READY);
  assert.deepEqual(onLoad, [1]);

  app.unmount();
});

test('a late walk:error from the unloaded frame is ignored after a reload', () => {
  const errors = [];
  const app = mount(Agent3D, { agentId: 'ag-1', onError: (e) => errors.push(e) });
  const oldWindow = app.iframe().contentWindow;

  app.rerender({ avatarId: 'av-42' });
  app.postFrom(oldWindow, { type: 'walk:error', error: 'late failure' });
  assert.deepEqual(errors, [], 'stale error messages must never fire onError');

  app.postFrom(app.iframe().contentWindow, { type: 'walk:error', error: 'current failure' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'current failure');

  app.unmount();
});

test('after a reload, speed is delivered to the new frame and never to the old window', () => {
  const app = mount(Agent3D, { agentId: 'ag-1', speed: 2 });
  const oldWindow = app.iframe().contentWindow;
  const oldOutbound = spyOnOutbound(app.iframe());

  app.rerender({ agentId: 'ag-2' });
  assert.notEqual(app.iframe().contentWindow, oldWindow);
  const newOutbound = spyOnOutbound(app.iframe());

  // Old frame becomes ready late: its message is ignored, so no config goes out.
  app.postFrom(oldWindow, READY);
  assert.equal(oldOutbound.length, 0, 'the unloaded window receives no speed config');
  assert.equal(newOutbound.length, 0);

  // New frame ready: speed lands on the current window, with the right origin.
  app.postFrom(app.iframe().contentWindow, READY);
  assert.equal(newOutbound.length, 1);
  assert.deepEqual(newOutbound[0].message, { type: 'walk:config', speed: 2 });
  assert.equal(newOutbound[0].targetOrigin, ORIGIN);
  assert.equal(oldOutbound.length, 0);

  oldOutbound.restore();
  newOutbound.restore();
  app.unmount();
});

test('each successive reload converges independently: onLoad once per current scene', () => {
  const onLoad = [];
  const app = mount(Agent3D, { agentId: 'ag-1', onLoad: () => onLoad.push(1) });
  const windows = [];

  for (const agentId of ['ag-1', 'ag-2', 'ag-3']) {
    if (agentId !== 'ag-1') {
      windows.push(app.iframe().contentWindow);
      app.rerender({ agentId });
    }
    app.postFrom(app.iframe().contentWindow, READY);
  }
  // Every earlier frame now sends a late ready: all must be dropped.
  for (const staleWindow of windows) app.postFrom(staleWindow, READY);

  assert.deepEqual(onLoad, [1, 1, 1], 'one onLoad per loaded scene, stale frames ignored');

  app.unmount();
});

test('re-renders that do not change the embed address keep the same iframe and do not re-fire callbacks', () => {
  const onLoad = [];
  const app = mount(Agent3D, {
    agentId: 'ag-1',
    width: 300,
    className: 'a',
    onLoad: () => onLoad.push(1),
  });
  const iframeBefore = app.iframe();

  app.postFrom(iframeBefore.contentWindow, READY);
  assert.deepEqual(onLoad, [1]);

  // New callback identities, sizing, styles and even a new speed value are
  // address-independent: no remount, and the readiness latch survives.
  app.rerender({ width: 480, className: 'b', style: { marginTop: 8 }, onLoad: () => onLoad.push(2) });
  app.rerender({ speed: 9, title: 'renamed frame' });
  assert.equal(app.iframe(), iframeBefore, 'unchanged src must not remount the iframe');
  assert.equal(app.iframe().getAttribute('src'), iframeBefore.getAttribute('src'));

  app.postFrom(iframeBefore.contentWindow, READY);
  assert.deepEqual(onLoad, [1], 'the already-ready scene must not re-fire onLoad');

  app.unmount();
});

test('baseUrl/controls/avatarId changes each remount the iframe', () => {
  const app = mount(Agent3D, { agentId: 'ag-1' });
  const before = app.iframe();

  app.rerender({ controls: 'keyboard' });
  assert.notEqual(app.iframe(), before);
  const afterControls = app.iframe();

  app.rerender({ baseUrl: 'https://staging.example.com' });
  assert.notEqual(app.iframe(), afterControls);
  const afterBase = app.iframe();
  assert.equal(new URL(app.iframe().getAttribute('src')).origin, 'https://staging.example.com');

  app.rerender({ avatarId: 'av-7' });
  assert.notEqual(app.iframe(), afterBase);

  app.unmount();
});

test('ref methods drive the current frame after a reload, never the unloaded one', () => {
  const ref = React.createRef();
  const app = mount(Agent3D, { agentId: 'ag-1', ref });
  const oldOutbound = spyOnOutbound(app.iframe());
  const oldWindow = app.iframe().contentWindow;

  app.rerender({ agentId: 'ag-2' });
  const newOutbound = spyOnOutbound(app.iframe());

  ref.current.setSpeed(0.8);
  ref.current.narrate('hello');
  ref.current.setAvatar('av-1');
  ref.current.setMotion('run');
  ref.current.setEnvironment('studio');
  ref.current.resetPose();
  ref.current.sendMessage({ type: 'walk:custom' });

  assert.equal(oldOutbound.length, 0, 'the old window must never be addressed');
  assert.deepEqual(
    newOutbound.map((c) => c.message),
    [
      { type: 'walk:config', speed: 0.8 },
      { type: 'walk:narrate', text: 'hello' },
      { type: 'walk:setAvatar', id: 'av-1' },
      { type: 'walk:setMotion', motion: 'run' },
      { type: 'walk:setEnv', env: 'studio' },
      { type: 'walk:resetPose' },
      { type: 'walk:custom' },
    ],
  );
  assert.ok(newOutbound.every((c) => c.targetOrigin === ORIGIN));
  assert.equal(ref.current.iframe, app.iframe(), 'handle.iframe tracks the live element');

  oldOutbound.restore();
  newOutbound.restore();
  app.unmount();
});

test('messages arriving after unmount are ignored and never fire callbacks', () => {
  const onLoad = [];
  const onError = [];
  const app = mount(Agent3D, {
    agentId: 'ag-1',
    onLoad: () => onLoad.push(1),
    onError: (e) => onError.push(e),
  });
  const lastWindow = app.iframe().contentWindow;

  app.unmount();
  assert.equal(app.iframe(), null);

  assert.doesNotThrow(() => {
    app.postFrom(lastWindow, READY);
    app.postFrom(lastWindow, { type: 'walk:error', error: 'post-unmount' });
  });
  assert.deepEqual(onLoad, []);
  assert.deepEqual(onError, []);
});

test('WalkEmbed (the alias) follows the same reload and late-message contract', () => {
  const onLoad = [];
  const app = mount(WalkEmbed, { agentId: 'ag-1', onLoad: () => onLoad.push(1) });
  const oldWindow = app.iframe().contentWindow;

  app.rerender({ agentId: 'ag-2' });
  app.postFrom(oldWindow, READY);
  assert.deepEqual(onLoad, []);

  app.postFrom(app.iframe().contentWindow, READY);
  assert.deepEqual(onLoad, [1]);

  app.unmount();
});

// Sanity guard that the test harness itself is running under real React with act.
test('harness sanity: React and act are available in the jsdom environment', () => {
  assert.equal(typeof ReactNS.createElement, 'function');
  assert.ok(window.document instanceof window.Document);
});
