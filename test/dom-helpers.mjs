// DOM harness for the client-side postMessage behavior tests.
//
// The markup tests use react-dom/server; effects, iframe lifecycle and
// postMessage only exist in a real document, so these helpers mount the
// shipped bundles into a jsdom window with react-dom/client. Each test file
// runs in its own Node process, so installing DOM globals here is isolated.
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
});
for (const name of ['MessageEvent', 'Event', 'HTMLElement', 'Element', 'Node', 'getComputedStyle']) {
  if (window[name] !== undefined) globalThis[name] = window[name];
}

export { React, act, window, JSDOM };

/**
 * Mount a component and return a controller for re-rendering, inspecting the
 * live iframe and dispatching postMessage events as the embed would.
 */
export function mount(Component, props = {}) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  let currentProps = props;

  act(() => {
    root.render(React.createElement(Component, currentProps));
  });

  return {
    container,
    /** Re-render with new props (shallow-merged over the previous ones). */
    rerender(next = {}) {
      currentProps = { ...currentProps, ...next };
      act(() => {
        root.render(React.createElement(Component, currentProps));
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
    },
    /** The iframe element currently mounted (null after unmount). */
    iframe() {
      return container.querySelector('iframe');
    },
    /**
     * Deliver a message as if `sourceWindow` (an iframe contentWindow) sent it
     * from `origin`. Defaults to the currently mounted iframe's window.
     */
    postFrom(sourceWindow, data, origin) {
      const source = sourceWindow ?? this.iframe()?.contentWindow;
      act(() => {
        window.dispatchEvent(
          new window.MessageEvent('message', { origin: origin ?? 'https://three.ws', source, data }),
        );
      });
    },
  };
}

/**
 * Record every postMessage call made on an iframe's contentWindow. Returns an
 * array of { message, targetOrigin } captured in order. Re-spy after a reload
 * because a remounted iframe has a brand-new contentWindow.
 */
export function spyOnOutbound(iframe) {
  const calls = [];
  const target = iframe.contentWindow;
  const original = target.postMessage.bind(target);
  target.postMessage = (message, targetOrigin) => {
    calls.push({ message, targetOrigin });
  };
  calls.restore = () => {
    target.postMessage = original;
  };
  return calls;
}
