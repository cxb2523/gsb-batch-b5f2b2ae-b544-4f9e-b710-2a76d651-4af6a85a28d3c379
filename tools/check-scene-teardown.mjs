/* =====================================================================
 * check-scene-teardown.mjs —— 换局拆除 / 重复 init 幂等性检查（Node）
 * ---------------------------------------------------------------------
 * 用**真实的 three3d/scene.js**（不建 WebGL 上下文，渲染器由垫片顶替）连续 init：
 *   1. 首次 init：没有旧局可拆，必须成功且拆除计数全 0；
 *   2. 换第二份最小假数据：旧局的对象/材质/几何体/纹理/标签/单位缓存必须被拆掉，
 *      新局没有地形 / 导弹 / 击杀时对应图层必须为空（不沿用旧对象）；
 *   3. 再装回第一份数据：getStats 与场景对象数必须与首次 init 完全一致（重复 init 幂等）；
 *   4. 连续 6 次换局：场景对象数不随次数增长（无泄漏累积）。
 *
 * 假 DOM 只实现 scene.js 实际用到的接口（createElement / appendChild /
 * querySelectorAll / className / canvas.getContext）；2D canvas 用假上下文，
 * 不依赖 node-canvas。
 *
 * 运行：node tools/check-scene-teardown.mjs
 * ===================================================================== */
import assert from 'node:assert';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

register('./scene-teardown-hook.mjs', import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/* ---------------------------------------------------------------- 假 DOM */
class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...names) { for (const n of names) { if (n) { this.set.add(n); } } this._sync(); }
  remove(...names) { for (const n of names) { this.set.delete(n); } this._sync(); }
  contains(n) { return this.set.has(n); }
  _sync() { this.el._className = Array.from(this.set).join(' '); }
}
class FakeText {
  constructor(text) { this.textContent = text == null ? '' : String(text); this.parentNode = null; }
  appendChild(c) { c.parentNode = this; return c; }
  removeChild(c) { if (c.parentNode === this) { c.parentNode = null; } return c; }
}
class FakeElement extends FakeText {
  constructor(tag) {
    super('');
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.style = {};
    this.parentNode = null;
    this._className = '';
    this.classList = new FakeClassList(this);
  }
  get className() { return this._className; }
  set className(v) {
    this._className = String(v || '');
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }
  appendChild(c) {
    if (c && c.parentNode) { c.parentNode.removeChild(c); }
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); }
    if (c) { c.parentNode = null; }
    return c;
  }
  /* 只支持两种选择器：'.ac-labels' 与 '#id'（scene.js 只用前者，CSS 注入用后者） */
  querySelectorAll(sel) {
    const out = [];
    const wantClass = sel.startsWith('.') ? sel.slice(1) : null;
    const wantId = sel.startsWith('#') ? sel.slice(1) : null;
    const walk = (node) => {
      for (const ch of node.children || []) {
        if (wantClass && ch.classList && ch.classList.contains(wantClass)) { out.push(ch); }
        if (wantId && ch.id === wantId) { out.push(ch); }
        walk(ch);
      }
    };
    walk(this);
    return out;
  }
  getContext() { return fake2dContext(); }
}

/* 2D 假上下文：地形/陆地填充只把像素画进 CanvasTexture，本检查不看像素结果。 */
function fake2dContext() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    createLinearGradient() { return { addColorStop() {} }; },
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, stroke() {},
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4 || 4) }; },
    putImageData() {}, getImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4 || 4) }; }
  };
}

function makeDocument() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const doc = new FakeText('');
  doc.head = head;
  doc.body = body;
  doc.documentElement = new FakeText('');
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.getElementById = (id) => {
    const walk = (node) => {
      if (node.id === id) { return node; }
      for (const ch of node.children || []) {
        const hit = walk(ch);
        if (hit) { return hit; }
      }
      return null;
    };
    return walk(body) || walk(head);
  };
  doc.createElement = (tag) => new FakeElement(tag);
  doc.querySelectorAll = (sel) => body.querySelectorAll(sel).concat(head.querySelectorAll(sel));
  return { doc, head, body };
}

/* --------------------------------------------------------------- 假数据 */
/* 最小 ACE_MISSION：本机 + 1 架空中 + 2 个地面、击杀 / 跑道 / 导弹 / 地形可选。 */
function makeMission(tag, opts) {
  const o = Object.assign({ terrain: true, missile: true, kills: true, runway: true }, opts || {});
  const n = 40, hz = 4, t0 = 0;
  const track = (base, hdg) => {
    const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), h = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = base + i * 180; y[i] = base * 0.5 + i * 60; z[i] = 2000 + i * 10; h[i] = hdg;
    }
    return { n, hz, t0, x, y, z, hdg: h };
  };
  const own = track(1000, 90);
  const tAir = track(3000, 80);
  return {
    meta: {
      source: 'fixture',
      window: { t0: 0, t1: (n - 1) / hz },
      replayTicks: { secPerTick: 1, tick0: 0 },
      squad: { authorUid: 501, members: [{ uid: 501, isAuthor: true }, { uid: 502 }] },
      player: { name: 'ALPHA 01', vehicleName: 'F-16' },
      replayHeader: { level: 'air_' + tag }
    },
    own,
    names: { own: 'ALPHA 01' },
    units: [
      { key: 'u-air', uid: 502, domain: 'air', n, hz, t0, x: tAir.x, y: tAir.y, z: tAir.z,
        hdg: tAir.hdg, side: 'ally', vehicleName: 'MIG-21', player: 'ALPHA 02' },
      { key: 'u-gnd1', uid: 601, domain: 'ground', n: 1, hz: 1, t0, x: [4000], y: [5000], z: [10],
        side: 'enemy', vehicleName: 'TANK', vehicleCategory: 'TANK' },
      { key: 'u-gnd2', uid: 602, domain: 'ground', n: 1, hz: 1, t0, x: [4050], y: [5030], z: [12],
        side: 'enemy', vehicleName: 'TANK', vehicleCategory: 'TANK' }
    ],
    events: o.kills ? [{ kind: 'kill', x: 3500, y: 4200, z: 30, t: 2 }] : [],
    runways: o.runway ? [{ x1: 0, y1: 0, x2: 3000, y2: 0, z1: 10, z2: 10, name: 'AF-01 RUNWAY' }] : [],
    missiles: o.missile ? [{
      n: 4, x: [1000, 2000, 3000, 4000], y: [1000, 1100, 1200, 1300],
      z: [1000, 1100, 1200, 1300], t: [0, 1, 2, 3]
    }] : [],
    terrain: o.terrain ? {
      meta: { map: 'air_' + tag, bounds: { minX: 0, maxX: 8000, minY: 0, maxY: 8000 } },
      contours: [{ elev: 100, lines: [{ pts: [0, 0, 100, 100, 200, 0] }] }],
      coastlines: [{ pts: [0, 8000, 8000, 8000] }],
      water: []
    } : null
  };
}

/* ---------------------------------------------------------------- 环境 */
function installGlobals() {
  const { doc, head, body } = makeDocument();
  const stage = new FakeElement('div');
  stage.id = 'stage';
  const canvas = new FakeElement('canvas');
  canvas.id = 'scene';
  canvas.width = 800; canvas.height = 600;
  canvas.clientWidth = 800; canvas.clientHeight = 600;
  stage.appendChild(canvas);
  body.appendChild(stage);

  globalThis.document = doc;
  globalThis.window = {
    devicePixelRatio: 1,
    ACE_MISSION: null,
    ACE_ATTITUDE: null,
    ACE_LANDMASK: null
  };
  globalThis.performance = { now: () => 0 };

  /* OrbitControls 需要的 DOM 接口 */
  canvas.getRootNode = () => doc;
  canvas.ownerDocument = doc;
  canvas.addEventListener = () => {};
  canvas.removeEventListener = () => {};
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  return { canvas, body, head, doc };
}

function countDomLabelBoxes(node) {
  let n = 0;
  const walk = (x) => {
    for (const ch of x.children || []) {
      if (ch.classList && ch.classList.contains('ac-labels')) { n++; }
      walk(ch);
    }
  };
  walk(node);
  return n;
}

function hasLayer(stats, name) {
  return (stats.scene.layers || []).indexOf(name) >= 0;
}

function stripVolatile(stats) {
  const s = Object.assign({}, stats);
  delete s.teardown;             /* 拆除计数天然随"有没有旧局"变化 */
  return s;
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  const { canvas, body } = installGlobals();
  await import('three');                                     /* 触发垫片加载 */
  const mod = await import(pathToFileURL(path.join(ROOT, 'three3d', 'scene.js')).href);
  const API = mod.ACESceneReal || globalThis.window.ACESceneReal;
  assert.ok(API && typeof API.init === 'function', 'scene.js 应导出 ACESceneReal');

  /* ---- 1. 首次 init：无旧局可拆 ---- */
  const A = makeMission('alpha', { terrain: true, missile: true, kills: true });
  assert.doesNotThrow(() => API.init(canvas, A), '首次 init 不能因为"没有旧局"报错');
  const statsA1 = API.getStats();
  const objectsA1 = statsA1.scene.objects;
  assert.ok(objectsA1 > 0, '首次 init 应建出场景对象');
  for (const k of ['objects', 'geometries', 'materials', 'textures', 'labelBoxes', 'unitCaches']) {
    assert.equal(statsA1.teardown[k], 0, '首次 init 拆除计数 ' + k + ' 必须为 0');
  }
  assert.equal(countDomLabelBoxes(body), 1, '首次 init 后应有 1 个标签层');
  assert.ok(statsA1.labels > 0, '本机 + 单位应有标签');
  assert.ok(hasLayer(statsA1, 'contours') && hasLayer(statsA1, 'coast') && hasLayer(statsA1, 'landFill'),
    '有地形数据时应建出等高线/海岸线/陆地填充');
  assert.ok(hasLayer(statsA1, 'missiles'), '有导弹数据时应建出弹道层');
  assert.ok(hasLayer(statsA1, 'kills'), '有击杀时应建出击杀层');
  assert.ok(hasLayer(statsA1, 'runways'), '有跑道时应建出跑道层');

  /* 播放一帧，让 ensureSeries / ensureValid 建立按单位惰性缓存 */
  API.render({ met: 1, identity: { own: 'ALPHA 01', squad: [] } });
  assert.equal(API.getStats().ready, true, 'render 后仍 ready');

  /* ---- 2. 换局到 B：无地形 / 无导弹 / 无击杀 ---- */
  const B = makeMission('bravo', { terrain: false, missile: false, kills: false, runway: false });
  API.init(canvas, B);
  const statsB = API.getStats();
  assert.ok(statsB.teardown.objects > 0, '换局必须从场景移除旧对象');
  assert.ok(statsB.teardown.geometries > 0, '旧局的几何体必须被释放');
  assert.ok(statsB.teardown.materials > 0, '旧局的材质必须被释放');
  assert.ok(statsB.teardown.textures > 0, '旧局的纹理（陆地/外框贴图）必须被释放');
  assert.equal(statsB.teardown.labelBoxes, 1, '旧标签层必须被摘掉');
  assert.ok(statsB.teardown.labels > 0, '旧标签列表必须清空');
  assert.ok(statsB.teardown.unitCaches > 0, '旧局的按单位缓存必须清掉');
  assert.equal(countDomLabelBoxes(body), 1, '换局后 DOM 上只保留新局的一个标签层');

  assert.equal(hasLayer(statsB, 'contours'), false, 'B 无地形 → 等高线层必须为空');
  assert.equal(hasLayer(statsB, 'coast'), false, 'B 无地形 → 海岸线层必须为空');
  assert.equal(hasLayer(statsB, 'landFill'), false, 'B 无地形 → 陆地填充必须为空');
  assert.equal(hasLayer(statsB, 'missiles'), false, 'B 无导弹 → 弹道层必须为空');
  assert.equal(hasLayer(statsB, 'kills'), false, 'B 无击杀 → 击杀层必须为空');
  assert.equal(hasLayer(statsB, 'runways'), false, 'B 无跑道 → 跑道层必须为空');
  assert.equal(hasLayer(statsB, 'grid'), true, '网格是本局按新 bounds 重建的，B 仍有');

  /* 交付数据本身不能被挂上缓存键（缓存只属于当前局包装对象） */
  for (const key of ['_series', '_valid', '_gaps', '_wing', '_stepMed']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(A.own, key), '交付数据 M.own 不应被挂缓存键 ' + key);
    for (const u of A.units) {
      assert.ok(!Object.prototype.hasOwnProperty.call(u, key), '交付数据 unit 不应被挂缓存键 ' + key);
    }
  }

  /* ---- 3. 再装回 A：与首次 init 完全一致 ---- */
  const A2 = makeMission('alpha', { terrain: true, missile: true, kills: true });
  API.init(canvas, A2);
  const statsA2 = API.getStats();
  assert.deepEqual(stripVolatile(statsA2), stripVolatile(statsA1),
    '同一份数据重复 init 后 getStats 必须与单次 init 一致');
  /* 画面等价：同一时刻渲染后，地面方块实例数（用画面直接相关量）与单次 init 相同 */
  API.render({ met: 1, identity: { own: 'ALPHA 01', squad: [] } });
  const groundA2 = API.getStats().scene.groundInstances;
  assert.equal(groundA2, 2, '重复 init 后同一时刻地面方块数应与单次 init 一致');

  /* ---- 3b. 纯工具层单测：计数器去重 / 幂等 ---- */
  const gc = await import(pathToFileURL(path.join(ROOT, 'three3d', 'scene-gc.js')).href);
  {
    const THREE2 = await import('three');
    const geo = new THREE2.BufferGeometry();
    const tex = new THREE2.Texture();
    const mat = new THREE2.MeshBasicMaterial({ map: tex });
    const scene = new THREE2.Scene();
    const a = new THREE2.Mesh(geo, mat), b = new THREE2.Mesh(geo, mat);
    scene.add(a); scene.add(b);
    const c1 = gc.createTeardownCounter();
    gc.disposeObjectTree(scene, c1);
    assert.equal(c1.geometries, 1, '共享几何体只能释放一次');
    assert.equal(c1.materials, 1, '共享材质只能释放一次');
    assert.equal(c1.textures, 1, '共享纹理只能释放一次');
    assert.equal(c1.objects, 3, '计数包含场景根与两个网格');
    /* 第二次拆同一棵（已拆过）再拆一次：不应抛错、计数按对象数继续走 */
    assert.doesNotThrow(() => gc.disposeObjectTree(scene, gc.createTeardownCounter()),
      '重复拆除同一对象树不得抛错');
  }
  {
    const u = { _series: {}, _valid: new Uint8Array(1), _gaps: [], n: 1 };
    const c = gc.createTeardownCounter();
    gc.clearUnitCaches([u], c);
    assert.equal(c.unitCaches, 3, '应清掉 3 个缓存键');
    assert.equal(u._series, undefined, '_series 必须被删除');
    const c2 = gc.createTeardownCounter();
    gc.clearUnitCaches([u], c2);
    assert.equal(c2.unitCaches, 0, '再清一次计数为 0（幂等）');
  }
  {
    const c = gc.createTeardownCounter();
    assert.doesNotThrow(() => gc.disposeLabels(null, null, c), '无标签层时不得抛错');
    assert.equal(c.labelBoxes, 0, '无标签层时计数为 0');
    assert.doesNotThrow(() => gc.disposeObjectTree(null, gc.createTeardownCounter()),
      '空对象树拆不得抛错');
    assert.equal(gc.UNIT_CACHE_KEYS.indexOf('_wing') >= 0, true, '翼展缓存键必须在清理列表里');
    assert.equal(gc.UNIT_CACHE_KEYS.indexOf('_stepMed') >= 0, true, '采样步长缓存键必须在清理列表里');
  }

  /* ---- 4. 连续换局不累积 ---- */
  const M = makeMission('charlie', { terrain: true, missile: true, kills: true });
  API.init(canvas, M);
  const count1 = API.getStats().scene.objects;
  for (let i = 0; i < 5; i++) { API.init(canvas, makeMission('charlie', { terrain: true, missile: true, kills: true })); }
  const countN = API.getStats().scene.objects;
  assert.equal(countN, count1, '连续 6 次换局后场景对象数必须稳定（不累积旧局）');
  assert.equal(API.getStats().ready, true, '连续换局后场景仍 ready');

  /* ---- 5. 空数据 / 无数据也不得抛错（幂等） ---- */
  assert.doesNotThrow(() => API.init(canvas, {}), '空数据 init 不能抛错');
  assert.doesNotThrow(() => API.init(canvas, { own: null, units: [] }), '无单位数据 init 不能抛错');
  assert.equal(API.getStats().ready, true, '空数据 init 后 ready 仍为 true');
  assert.equal(countDomLabelBoxes(body), 1, '空数据 init 后标签层仍只有一个');

  console.log('scene teardown ok');
  console.log('  首次 init 拆除计数   =', JSON.stringify(statsA1.teardown));
  console.log('  换局 A→B 拆除计数    =', JSON.stringify(statsB.teardown));
  console.log('  场景对象数 A1/B/末局 =', objectsA1, statsB.scene.objects, countN);
  console.log('  B 图层               =', statsB.scene.layers.join(','));
}

main().catch((e) => { console.error(e); process.exit(1); });
