import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CadViewer,
  CadWebGLRenderer,
  createCadRenderDocument,
  readCadColorPolicy
} from '../dist/cad-viewer.es.js';

// ---------------------------------------------------------------------------
// Offline WebGL harness: a minimal GL context that retains every uploaded
// buffer so tests can inspect the actual RGBA bytes the renderer produces and
// track buffer deletion (GPU leak detection).
// ---------------------------------------------------------------------------

const GL_CONSTANTS = {
  VERTEX_SHADER: 35633,
  FRAGMENT_SHADER: 35632,
  LINK_STATUS: 35714,
  COMPILE_STATUS: 35713,
  ARRAY_BUFFER: 34962,
  STATIC_DRAW: 35044,
  FLOAT: 5126,
  UNSIGNED_BYTE: 5121,
  LINES: 1,
  TRIANGLES: 4,
  POINTS: 0,
  COLOR_BUFFER_BIT: 16384,
  DEPTH_TEST: 2929,
  BLEND: 3042,
  SRC_ALPHA: 770,
  ONE_MINUS_SRC_ALPHA: 771
};

function createMockWebGL() {
  const buffers = [];
  const gl = {
    ...GL_CONSTANTS,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    deleteShader() {},
    getShaderInfoLog: () => '',
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    deleteProgram() {},
    getProgramInfoLog: () => '',
    getUniformLocation: () => ({}),
    getAttribLocation: (_program, name) => (name === 'a_position' ? 0 : 1),
    createBuffer() {
      const buffer = { id: buffers.length, data: null, deleted: false };
      buffers.push(buffer);
      return buffer;
    },
    bindBuffer() {},
    bufferData(_target, data) {
      buffers[buffers.length - 1].data = data;
    },
    deleteBuffer(buffer) {
      if (buffer) buffer.deleted = true;
    },
    viewport() {},
    clearColor() {},
    clear() {},
    disable() {},
    enable() {},
    blendFunc() {},
    useProgram() {},
    uniform2f() {},
    uniform1f() {},
    vertexAttribPointer() {},
    enableVertexAttribArray() {},
    drawArrays() {}
  };
  return { gl, buffers };
}

const noop2dContext = new Proxy({}, {
  get(target, property) {
    if (property === 'measureText') return () => ({ width: 10 });
    if (['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth'].includes(property)) {
      return target[property];
    }
    return () => {};
  },
  set(target, property, value) {
    target[property] = value;
    return true;
  }
});

function installDom() {
  const webglState = createMockWebGL();
  const parent = { style: {}, classList: { add() {}, remove() {}, contains: () => false }, appendChild() {} };
  const canvas = {
    width: 1,
    height: 1,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    classList: { add() {}, remove() {} },
    parentElement: parent,
    addEventListener() {},
    removeEventListener() {},
    getContext(kind) {
      return kind === '2d' ? noop2dContext : webglState.gl;
    }
  };
  globalThis.window = {
    devicePixelRatio: 1,
    getComputedStyle: () => ({ position: 'absolute' }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {}
  };
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') {
        return { style: {}, classList: { add() {}, remove() {}, contains: () => false }, replaceChildren() {} };
      }
      return {
        width: 1,
        height: 1,
        style: {},
        className: '',
        setAttribute() {},
        classList: { add() {}, remove() {} },
        remove() {},
        getContext: () => noop2dContext
      };
    }
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  return { canvas, buffers: webglState.buffers };
}

function createSourceDocument() {
  return {
    format: 'dxf',
    layers: { Walls: { name: 'Walls', color: '#ff0000' } },
    blocks: {},
    metadata: {},
    warnings: [],
    entities: [
      // Authored red stroke.
      { type: 'LINE', color: '#ff0000', startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 10 } },
      // BYLAYER stroke resolving to the red layer color.
      { type: 'LINE', layer: 'Walls', startPoint: { x: 0, y: 10 }, endPoint: { x: 10, y: 0 } },
      // Authored green fill plus a white stroke.
      {
        type: 'SOLID',
        color: '#ffffff',
        fillColor: '#00ff00',
        vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]
      }
    ]
  };
}

/** Collects the distinct live RGBA byte tuples currently uploaded to the GPU. */
function liveColorTuples(buffers) {
  const colors = new Set();
  for (const buffer of buffers) {
    if (buffer.deleted || !(buffer.data instanceof Uint8Array) || buffer.data.length < 4) continue;
    for (let i = 0; i + 3 < buffer.data.length; i += 4) {
      colors.add(`${buffer.data[i]},${buffer.data[i + 1]},${buffer.data[i + 2]},${buffer.data[i + 3]}`);
    }
  }
  return [...colors].sort();
}

function liveBufferCount(buffers) {
  return buffers.filter((buffer) => !buffer.deleted).length;
}

test('WebGL monochrome policy replaces every retained stroke and fill color', () => {
  const { canvas, buffers } = installDom();
  const renderer = new CadWebGLRenderer(canvas, { foreground: '#ffffff', background: '#0b1020' });
  const source = createSourceDocument();

  renderer.setDocument(createCadRenderDocument(source, { mode: 'source' }));
  const sourceColors = liveColorTuples(buffers);
  assert.ok(sourceColors.some((c) => c.startsWith('255,0,0')), `expected authored red in source scene: ${sourceColors}`);
  assert.ok(sourceColors.some((c) => c.startsWith('0,255,0')), `expected authored green fill in source scene: ${sourceColors}`);

  renderer.setDocument(createCadRenderDocument(source, { mode: 'monochrome', monochromeColor: '#102030' }));
  const monoColors = liveColorTuples(buffers);
  assert.deepEqual(monoColors, ['16,32,48,255'], `all renderable colors must become the policy color: ${monoColors}`);

  // The render document carries the policy while the caller-owned source document never does.
  assert.deepEqual(readCadColorPolicy(renderer.getDocument()), { mode: 'monochrome', monochromeColor: '#102030' });
  assert.deepEqual(source.metadata, {});
  assert.equal(readCadColorPolicy(source).mode, 'source');

  renderer.destroy();
});

test('WebGL restores authored ACI/BYLAYER colors after switching back to source', () => {
  const { canvas, buffers } = installDom();
  const renderer = new CadWebGLRenderer(canvas, { foreground: '#ffffff', background: '#0b1020' });
  const source = createSourceDocument();

  renderer.setDocument(createCadRenderDocument(source, { mode: 'source' }));
  const baseline = liveColorTuples(buffers);
  assert.ok(baseline.some((c) => c.startsWith('255,0,0')));
  assert.ok(baseline.some((c) => c.startsWith('0,255,0')));

  renderer.setDocument(createCadRenderDocument(source, { mode: 'monochrome', monochromeColor: '#102030' }));
  assert.deepEqual(liveColorTuples(buffers), ['16,32,48,255']);

  renderer.setDocument(createCadRenderDocument(source, { mode: 'source' }));
  const restored = liveColorTuples(buffers);
  assert.deepEqual(restored, baseline, 'source mode must restore the original ACI/BYLAYER resolution');
  assert.ok(restored.some((c) => c.startsWith('255,0,0')));
  assert.ok(restored.some((c) => c.startsWith('0,255,0')));
  assert.deepEqual(source.metadata, {});

  renderer.destroy();
});

test('WebGL monochrome falls back to the renderer foreground when no policy color is set', () => {
  const { canvas, buffers } = installDom();
  const renderer = new CadWebGLRenderer(canvas, { foreground: '#aabbcc', background: '#0b1020' });
  const source = createSourceDocument();

  // A policy without monochromeColor: readCadColorPolicy reports the mode only.
  const renderDoc = createCadRenderDocument(source, { mode: 'monochrome' });
  assert.equal(readCadColorPolicy(renderDoc).monochromeColor, undefined);
  renderer.setDocument(renderDoc);

  // #aabbcc -> rgb(170, 187, 204)
  assert.deepEqual(liveColorTuples(buffers), ['170,187,204,255']);

  // Changing the renderer foreground changes the fallback; the rebuild keeps the policy active.
  renderer.setOptions({ foreground: '#010203' });
  assert.deepEqual(liveColorTuples(buffers), ['1,2,3,255']);
  assert.deepEqual(source.metadata, {});

  renderer.destroy();
});

test('rebuildScene() re-resolves policy colors without changing the view or leaking buffers', () => {
  const { canvas, buffers } = installDom();
  const renderer = new CadWebGLRenderer(canvas, { foreground: '#ffffff', background: '#0b1020' });
  const source = createSourceDocument();

  renderer.setDocument(createCadRenderDocument(source, { mode: 'source' }));
  renderer.setViewState({ centerX: 1, centerY: 2, scale: 3 });
  const expectedView = renderer.getViewState();
  const liveAfterLoad = liveBufferCount(buffers);
  assert.ok(liveAfterLoad > 0);

  renderer.setDocument(createCadRenderDocument(source, { mode: 'monochrome', monochromeColor: '#224466' }));
  renderer.setViewState(expectedView);
  assert.deepEqual(liveColorTuples(buffers), ['34,68,102,255']);

  // Re-running the rebuild from the same active document stays monochrome, steady and leak-free.
  renderer.rebuildScene();
  assert.deepEqual(liveColorTuples(buffers), ['34,68,102,255']);
  assert.deepEqual(renderer.getViewState(), expectedView);
  assert.equal(liveBufferCount(buffers), liveAfterLoad);

  for (let i = 0; i < 6; i++) {
    renderer.setDocument(createCadRenderDocument(source, i % 2 === 0 ? { mode: 'monochrome', monochromeColor: '#102030' } : { mode: 'source' }));
    renderer.setViewState(expectedView);
    assert.deepEqual(renderer.getViewState(), expectedView, 'view center and scale must not jump across policy rebuilds');
  }
  assert.equal(liveBufferCount(buffers), liveAfterLoad, 'rebuilding the retained scene must not accumulate GPU buffers');
  assert.ok(buffers.length > liveAfterLoad, 'the harness should have observed multiple buffer generations');

  renderer.clear();
  assert.equal(liveBufferCount(buffers), 0, 'clear() must release the retained GPU buffers');

  renderer.destroy();
});

test('CadViewer color-mode toggle rebuilds the WebGL scene while keeping the view fixed', () => {
  const { canvas, buffers } = installDom();
  const viewer = new CadViewer({ renderer: 'webgl', canvas, autoFit: false });
  const source = createSourceDocument();

  viewer.setDocument(source);
  viewer.renderer.setViewState({ centerX: 3.25, centerY: -7.5, scale: 4.5 });
  const expectedView = viewer.renderer.getViewState();

  viewer.setColorMode('monochrome', '#102030');
  assert.deepEqual(liveColorTuples(buffers), ['16,32,48,255']);
  assert.deepEqual(viewer.renderer.getViewState(), expectedView, 'monochrome toggle must not pan or zoom');
  assert.equal(viewer.getColorMode(), 'monochrome');

  viewer.setColorMode('source');
  const colors = liveColorTuples(buffers);
  assert.ok(colors.some((c) => c.startsWith('255,0,0')));
  assert.ok(colors.some((c) => c.startsWith('0,255,0')));
  assert.deepEqual(viewer.renderer.getViewState(), expectedView, 'source toggle must not pan or zoom');
  assert.equal(viewer.getColorMode(), 'source');

  // The parser-owned document and the caller's reference stay untouched by the
  // color policy (reference bookkeeping keys are managed separately by the viewer).
  assert.equal(source.metadata.cadColorMode, undefined);
  assert.equal(source.metadata.cadMonochromeColor, undefined);
  assert.equal(viewer.getSourceDocument(), source);

  viewer.destroy();
});

test('captureCanvas outputs the monochrome scene and leaves source documents untouched', () => {
  const { canvas, buffers } = installDom();
  const renderer = new CadWebGLRenderer(canvas, { foreground: '#ffffff', background: '#0b1020' });
  const source = createSourceDocument();
  const sourceMetadataSnapshot = JSON.stringify(source.metadata);

  renderer.setDocument(createCadRenderDocument(source, { mode: 'monochrome', monochromeColor: '#102030' }));

  const drawnLayers = [];
  const snapshot = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (layer) => drawnLayers.push(layer) })
  };
  canvas.ownerDocument = { createElement: () => snapshot };

  const result = renderer.captureCanvas();
  assert.equal(result, snapshot);
  assert.equal(snapshot.width, canvas.width);
  assert.equal(snapshot.height, canvas.height);
  assert.ok(drawnLayers.includes(canvas), 'capture must composite the WebGL vector canvas');
  // The retained scene behind the capture is still monochrome.
  assert.deepEqual(liveColorTuples(buffers), ['16,32,48,255']);
  assert.equal(JSON.stringify(source.metadata), sourceMetadataSnapshot);
  assert.equal(readCadColorPolicy(source).mode, 'source');

  renderer.destroy();
});

test('monochrome keeps authored alpha while replacing RGB bytes', () => {
  const { canvas, buffers } = installDom();
  const renderer = new CadWebGLRenderer(canvas, { foreground: '#ffffff', background: '#0b1020' });
  const translucent = {
    format: 'dxf',
    layers: {},
    blocks: {},
    metadata: {},
    warnings: [],
    entities: [
      { type: 'LINE', color: 'rgba(255, 0, 0, 0.5)', startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 10 } }
    ]
  };

  renderer.setDocument(createCadRenderDocument(translucent, { mode: 'monochrome', monochromeColor: '#102030' }));
  // rgb(16,32,48) with the authored 0.5 alpha -> 128.
  assert.deepEqual(liveColorTuples(buffers), ['16,32,48,128']);
  assert.deepEqual(translucent.metadata, {});

  renderer.destroy();
});

test('monochrome policy also recolors overlay text and image placeholders', () => {
  const fills = [];
  const strokes = [];
  const trackingContext = new Proxy({}, {
    get(target, property) {
      if (property === 'measureText') return () => ({ width: 10 });
      if (['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth'].includes(property)) return target[property];
      return (...args) => {
        if (property === 'fillText' || property === 'fillRect' || property === 'fill') fills.push(target.fillStyle);
        if (property === 'stroke' || property === 'strokeRect') strokes.push(target.strokeStyle);
      };
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  });

  const webglState = createMockWebGL();
  const parent = { style: {}, classList: { add() {}, remove() {}, contains: () => false }, appendChild() {} };
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    classList: { add() {}, remove() {} },
    parentElement: parent,
    addEventListener() {},
    removeEventListener() {},
    getContext(kind) {
      return kind === '2d' ? trackingContext : webglState.gl;
    }
  };
  globalThis.window = {
    devicePixelRatio: 1,
    getComputedStyle: () => ({ position: 'absolute' }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {}
  };
  globalThis.document = {
    createElement() {
      return {
        width: 1, height: 1, style: {}, className: '', setAttribute() {},
        classList: { add() {}, remove() {} }, remove() {},
        getContext: () => trackingContext
      };
    }
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };

  const document = {
    format: 'dxf',
    layers: {},
    blocks: {},
    metadata: {},
    warnings: [],
    entities: [
      { type: 'TEXT', color: '#ff0000', insertionPoint: { x: 1, y: 1 }, textHeight: 2, rawText: 'A' },
      { type: 'IMAGE', color: '#0000ff', insertionPoint: { x: 0, y: 0 }, width: 10, height: 10 }
    ]
  };

  const renderer = new CadWebGLRenderer(canvas, { foreground: '#ffffff', background: '#0b1020', showImagePlaceholders: true });
  renderer.setDocument(createCadRenderDocument(document, { mode: 'monochrome', monochromeColor: '#102030' }));
  fills.length = 0;
  strokes.length = 0;
  renderer.render();

  assert.ok(fills.includes('rgb(16, 32, 48)'), `text fill must use the policy color: ${fills}`);
  assert.ok(strokes.includes('rgb(16, 32, 48)'), `image placeholder stroke must use the policy color: ${strokes}`);

  // Back to source: the authored colors return on the overlay as well.
  renderer.setDocument(createCadRenderDocument(document, { mode: 'source' }));
  fills.length = 0;
  strokes.length = 0;
  renderer.render();
  assert.ok(fills.includes('#ff0000'), `source text fill must be restored: ${fills}`);
  assert.ok(strokes.some((style) => String(style).includes('255')), `source placeholder stroke must be restored: ${strokes}`);

  renderer.destroy();
});
