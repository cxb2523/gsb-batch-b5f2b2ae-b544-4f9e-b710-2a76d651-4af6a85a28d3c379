// Minimal DOM + WebGL stubs so the three.js World can run headless under node:test.
// The real browser supplies all of this; here every surface the World touches is an in-memory fake,
// and WebGL calls are no-ops because no frame is rendered in the tests (logic runs without drawing).
import type { StageCallbacks } from '../../application/ports.ts';

export interface StubElement {
  tagName: string;
  clientWidth: number;
  clientHeight: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  classList: { add: (t: string) => void; remove: (t: string) => void; toggle: (t: string) => void; contains: (t: string) => boolean };
  children: StubElement[];
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  appendChild: (c: StubElement) => void;
  removeChild: (c: StubElement) => void;
  remove: () => void;
  addEventListener: (...a: unknown[]) => void;
  removeEventListener: (...a: unknown[]) => void;
  dispatchEvent: (...a: unknown[]) => void;
  setAttribute: (...a: unknown[]) => void;
  removeAttribute: (...a: unknown[]) => void;
  hasAttribute: (n: string) => boolean;
  querySelector: (sel: string) => StubElement;
  querySelectorAll: (sel: string) => StubElement[];
  blur: () => void;
  focus: () => void;
  click: () => void;
  getRootNode: () => { addEventListener: () => void; removeEventListener: () => void };
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number; right: number; bottom: number };
  contains: (n: unknown) => boolean;
  firstChild: StubElement;
  getContext?: (type: string) => unknown;
  width?: number;
  height?: number;
}

export function makeElement(tag = 'div'): StubElement {
  const el: StubElement = {
    tagName: tag.toUpperCase(),
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    hidden: false,
    innerHTML: '',
    textContent: '',
    appendChild(c) { this.children.push(c); },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setAttribute() {},
    removeAttribute() {},
    hasAttribute: () => false,
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    blur() {},
    focus() {},
    click() {},
    getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    contains: () => false,
    firstChild: undefined as unknown as StubElement,
  };
  // The bubble is the avatar label's first child; give a leaf node so it does not recurse into makeElement.
  el.firstChild = { ...makeLeaf('span') };
  return el;
}

function makeLeaf(tag: string): StubElement {
  return {
    tagName: tag.toUpperCase(),
    clientWidth: 0, clientHeight: 0, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], hidden: false, innerHTML: '', textContent: '',
    appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    setAttribute() {}, removeAttribute() {}, hasAttribute: () => false,
    querySelector: () => makeLeaf('span'), querySelectorAll: () => [],
    blur() {}, focus() {}, click() {},
    getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    contains: () => false, firstChild: null as unknown as StubElement,
  };
}

function makeCtx2d(): unknown {
  return new Proxy(
    {
      measureText: () => ({ width: 0 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      getImageData: () => ({ data: [] }),
      putImageData() {},
    },
    { get: (t, p) => (p in t ? (t as Record<string | symbol, unknown>)[p] : () => {}), set: () => true },
  );
}

function makeGlCtx(): unknown {
  const handler = {
    get: (_t: unknown, p: string | symbol) => {
      if (p === 'canvas') return { width: 300, height: 150 };
      if (p === 'getExtension') {
        // Every WebGL extension the postprocessing chain probes for exists as an empty object.
        return () => new Proxy({}, { get: () => () => {}, set: () => true });
      }
      if (p === 'getParameter') return () => 'stub-gl';
      if (p === 'getShaderPrecisionFormat') return () => ({ rangeMin: 1, rangeMax: 1, precision: 1 });
      if (p === 'getContextAttributes') return () => ({});
      return () => {};
    },
    set: () => true,
  };
  return new Proxy({}, handler);
}

function makeCanvas(): StubElement {
  const c = makeElement('canvas');
  c.width = 300;
  c.height = 150;
  c.getContext = (type: string) => (type === '2d' ? makeCtx2d() : makeGlCtx());
  return c;
}

/** Installs the headless browser globals for one test file. Idempotent enough for a single import side effect. */
export function installDomStubs() {
  const documentStub = {
    createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : makeElement(tag)),
    createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? makeCanvas() : makeElement(tag)),
    getElementById: () => null,
    hidden: false,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
  };
  (globalThis as Record<string, unknown>).document = documentStub;
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).addEventListener = () => {};
  (globalThis as Record<string, unknown>).removeEventListener = () => {};
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as Record<string, unknown>).devicePixelRatio = 1;
  (globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
}

// ESM hoists imports above every statement, so the stubs are installed at module load: anything the
// test imports afterwards (furniture.ts builds a canvas texture at module scope) finds a `document`.
installDomStubs();

export const noopCallbacks = {} as StageCallbacks;
