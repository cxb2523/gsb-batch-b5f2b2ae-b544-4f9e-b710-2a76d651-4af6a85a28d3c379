/* =====================================================================
 * scene-gc.js —— 换局拆除的纯工具（不 import three / DOM，Node 可直接跑）
 * ---------------------------------------------------------------------
 * scene.js 在每次 init 装载新数据前调用这里的函数，把上一局创建的
 * 对象、几何体、材质、纹理、标签 DOM 与按单位缓存全部释放。
 *
 * 设计约束：
 *   1. 只依赖鸭子类型（isTexture / geometry / material / dispose / children），
 *      因此既能在浏览器里拆 three 对象，也能在 Node 检查脚本里拆假对象；
 *   2. 所有计数用 Set 去重：多个网格共享的材质/几何体只释放一次；
 *   3. 任何一步失败都不抛出（换局不能因为一个坏对象整局黑屏），
 *      调用方拿到的计数仍然准确。
 * ===================================================================== */

/* prepUnits 创建的包装对象上的惰性缓存键。
 * 这些缓存（航迹序列 / 有效点 / 断口 / 翼展 / 采样步长）只对"当前局"的
 * 包装对象有意义；换局时必须显式删掉，避免同一份数据对象被复用时拿到旧局结果。 */
export const UNIT_CACHE_KEYS = ['_series', '_valid', '_gaps', '_wing', '_stepMed'];

export function createTeardownCounter() {
  return {
    objects: 0,          /* 从场景摘下的对象数（含子节点） */
    geometries: 0,       /* 实际 dispose 的几何体（去重） */
    materials: 0,        /* 实际 dispose 的材质（去重） */
    textures: 0,         /* 实际 dispose 的纹理（去重，含材质上的贴图） */
    labelBoxes: 0,       /* 摘掉的 .ac-labels 容器数 */
    labels: 0,           /* 上一局标签列表的条目数（由调用方填） */
    unitCaches: 0        /* 清掉的按单位缓存键数量 */
  };
}

function texturesOf(material) {
  const out = [];
  if (!material || typeof material !== 'object') { return out; }
  for (const key of Object.keys(material)) {
    const v = material[key];
    if (v && v.isTexture === true) { out.push(v); }
  }
  return out;
}

/* 去重集合按 counter 归属：同一次拆除可能对场景里多个根节点分别调用本函数，
 * 而它们共享同一个材质/纹理（例如地图外框的 4 面墙）。集合挂在 counter 上，
 * 保证跨调用也只释放一次、只计数一次。 */
const _seenByCounter = new WeakMap();
function seenSets(counter) {
  let s = _seenByCounter.get(counter);
  if (!s) {
    s = { geo: new Set(), mat: new Set(), tex: new Set() };
    _seenByCounter.set(counter, s);
  }
  return s;
}

/**
 * 从场景树根节点开始，释放 geometry / material / texture，并摘除子节点引用。
 * 调用方负责把根节点从 scene 上 remove（本函数不做父子关系修改，便于 Node 假对象测试）。
 */
export function disposeObjectTree(root, counter) {
  const c = counter || createTeardownCounter();
  const seen = seenSets(c);

  const disposeTexture = (tex) => {
    if (!tex || seen.tex.has(tex)) { return; }
    seen.tex.add(tex);
    c.textures++;
    try { if (typeof tex.dispose === 'function') { tex.dispose(); } } catch (e) { /* 已失效的纹理 */ }
  };
  const disposeMaterial = (mat) => {
    if (!mat || seen.mat.has(mat)) { return; }
    seen.mat.add(mat);
    c.materials++;
    for (const tex of texturesOf(mat)) { disposeTexture(tex); }
    try { if (typeof mat.dispose === 'function') { mat.dispose(); } } catch (e) { /* 已失效的材质 */ }
  };
  const disposeGeometry = (geo) => {
    if (!geo || seen.geo.has(geo)) { return; }
    seen.geo.add(geo);
    c.geometries++;
    try { if (typeof geo.dispose === 'function') { geo.dispose(); } } catch (e) { /* 已失效的几何体 */ }
  };

  const visit = (obj) => {
    if (!obj) { return; }
    c.objects++;
    if (obj.isInstancedMesh) {
      /* three r186 的 InstancedMesh.dispose() 只释放 morphTexture 并通知渲染器
       * 解绑 instanceMatrix / instanceColor 的缓冲；geometry 与 material 仍要自己释放。 */
      disposeGeometry(obj.geometry);
      try { if (typeof obj.dispose === 'function') { obj.dispose(); } } catch (e) { /* 无渲染器时 */ }
    } else {
      disposeGeometry(obj.geometry);
    }
    if (Array.isArray(obj.material)) {
      for (const mat of obj.material) { disposeMaterial(mat); }
    } else {
      disposeMaterial(obj.material);
    }
    const children = obj.children || [];
    for (let i = 0; i < children.length; i++) { visit(children[i]); }
  };

  visit(root);
  return c;
}

/** 摘掉标签层容器，并兜底清扫文档里游离的 .ac-labels（旧版本留下的节点）。 */
export function disposeLabels(labelBox, doc, counter) {
  const c = counter || createTeardownCounter();
  /* 同一次拆除里 labelBox 可能也出现在 querySelectorAll 的结果里：两者共用一个 seen。 */
  let seen = _seenByCounter.get(c);
  if (!seen) { seen = { geo: new Set(), mat: new Set(), tex: new Set(), el: new Set() }; _seenByCounter.set(c, seen); }
  if (!seen.el) { seen.el = new Set(); }

  const remove = (el) => {
    if (!el || seen.el.has(el)) { return; }
    seen.el.add(el);
    c.labelBoxes++;
    try {
      if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el);
      }
    } catch (e) { /* 已经不在 DOM 上 */ }
    try { if ('textContent' in el) { el.textContent = ''; } } catch (e) { /* 只读节点 */ }
  };

  if (labelBox) { remove(labelBox); }
  if (doc && typeof doc.querySelectorAll === 'function') {
    let stale = [];
    try { stale = doc.querySelectorAll('.ac-labels'); } catch (e) { stale = []; }
    for (let i = 0; i < stale.length; i++) { remove(stale[i]); }
  }
  return c;
}

/** 清掉一组单位包装对象上的惰性缓存（航迹序列 / 有效点 / 断口 / 翼展 / 步长）。 */
export function clearUnitCaches(units, counter) {
  const c = counter || createTeardownCounter();
  const list = Array.isArray(units) ? units : (units ? [units] : []);
  for (const u of list) {
    if (!u || typeof u !== 'object') { continue; }
    for (const key of UNIT_CACHE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(u, key)) {
        try { delete u[key]; } catch (e) { /* 冻结对象：不影响主流程 */ }
        c.unitCaches++;
      }
    }
  }
  return c;
}
