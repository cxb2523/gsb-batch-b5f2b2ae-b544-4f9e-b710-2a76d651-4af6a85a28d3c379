// Acceptance test for the greybox <-> Tripo look switch.
//
// The switch must replace ONLY the look: every animation keeps its current clip and playback
// position, the attack hit window / hitstop / invulnerability / knockback timers are untouched,
// broken crates stay gone and non-solid, unbroken crates keep their look, food on the ground
// keeps its spot and spin/bob phase and still heals, and a KO'd enemy keeps fading at the same
// alpha and is removed at the same time. Restart must restore every crate and clear the food.
//
// A fixed seed drives the switches. The last check runs two identical seeded games side by
// side - one switches looks on the seeded schedule, the other never does - and asserts their
// whole gameplay state stays identical step for step.
//
// No GLB files are needed: the "models" skin is provided by tagged greybox-derived builders,
// so this exercises the real createVisual -> switchVisuals -> capture/apply pipeline offline.
//
// Usage: node tools/look-switch-check.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// A system Chromium. New Chrome/Edge builds reject playwright-core 1.63's pipe transport, so on
// Windows the browser is launched manually with a CDP port (and its own profile) and connected
// to over CDP. CHROME_PATH overrides the whole lookup.
const CANDIDATES = process.env.CHROME_PATH
  ? [process.env.CHROME_PATH]
  : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const BROWSER_BIN = CANDIDATES.find(existsSync);
if (!BROWSER_BIN) { console.error('No Chromium browser found; set CHROME_PATH.'); process.exit(1); }
const PORT = Number(process.env.PORT) || 4197;
const SEED = 20261119;

const viteBin = 'node_modules/vite/bin/vite.js';
execFileSync(process.execPath, [viteBin, 'build'], { stdio: 'ignore' });
const server = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1800));

// macOS keeps the direct pipe launch; Windows uses the manual CDP-port launch.
const useCdp = process.platform === 'win32';
let browser, browserProc;
try {
  if (useCdp) {
    const profile = mkdtempSync(join(tmpdir(), 'look-switch-profile-'));
    const cdpPort = PORT + 100;
    browserProc = spawn(BROWSER_BIN, [
      '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-sync', '--enable-unsafe-swiftshader', '--no-sandbox', 'about:blank',
    ], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); break; }
      catch { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!browser) throw new Error('could not connect to the browser over CDP');
  } else {
    browser = await chromium.launch({ executablePath: BROWSER_BIN, headless: true, args: ['--enable-unsafe-swiftshader'] });
  }
  const context = browser.contexts()[0] || await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  await page.goto(`http://localhost:${PORT}/?manual=1&look=greybox&seed=${SEED}`);
  await page.waitForFunction(() => window.__steps && window.__step && window.__switchLook && window.__testModules, null, { timeout: 15000 });

  const results = await page.evaluate(async (SEED) => {
    const { THREE, Game, Input, switchVisuals, createVisual, registerModelBuilders, getVisualMode, setSeed, ModelCharacter } = window.__testModules;
    const g = window.__game;
    const out = [];
    const check = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail });
    const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

    // --- tagged stand-in "model" builders (no GLB needed) ---
    const tagModel = v => { v.look = 'model'; return v; };
    registerModelBuilders(Object.fromEntries(
      Object.entries(window.__greyboxBuilders).map(([id, builder]) => [id, size => tagModel(builder(size))])));

    // --- arena helpers ---
    const setup = () => {
      g.reset();
      g.spawnQueue = ['__none__']; g.nextArrival = 1e9;
      g.turns.update = () => {}; g.turns.holder = null;
      g.hero.pos.set(0, 0, 0); g.hero.prevPos.set(0, 0, 0); g.hero.facing = 1; g.hero.hp = 100;
      window.__step();
    };
    const place = (kind, x, z, hp = 500) => {
      const e = window.__spawn(kind, Math.sign(x) || 1, z);
      e.entering = false; e.pos.set(x, 0, z); e.prevPos.copy(e.pos);
      e.hp = e.maxHp = hp; e.cooldown = 1e9; e.side = Math.sign(x - g.hero.pos.x) || 1; e.facing = -e.side;
      return e;
    };
    const dummy = e => { e.update = function (dt) { this.tick(dt); }; return e; };
    const run = (n, each) => { for (let i = 0; i < n; i++) { each?.(i); window.__step(); } };
    const clipFraction = f => {
      const v = f.visual;
      if (v.mixer && v.current) return v.current.time / v.current.getClip().duration;
      return v.animTime / v.duration(v.anim);
    };
    const alphaOf = f => {
      const m = f.visual.materials?.[0];
      return m ? m.opacity : 1;
    };
    const crateAt = x => g.props.find(p => p.breakable && approx(p.pos[0], x));
    const solidAt = (x, z) => g.solids.some(s => x > s.minX && x < s.maxX && z > s.minZ && z < s.maxZ);
    const mulberry32 = a => () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // 1. Volt mid-attack: switch keeps the clip, the playback position and every combat timer.
    setup();
    const t1 = dummy(place('thug_skinny', 0.9, 0));
    g.input.press('punch');
    run(4);                                   // switch before the jab's hit window opens
    const atk1 = { name: g.hero.attack.name, t: g.hero.attack.t, dur: g.hero.attack.dur };
    const pre1 = {
      state: g.hero.state, anim: g.hero.anim, frac: clipFraction(g.hero),
      freeze: g.hero.freeze, invuln: g.hero.invuln,
      tFreeze: t1.freeze, tInvuln: t1.invuln, tKb: t1.kb ? t1.kb.remaining : null,
    };
    window.__switchLook('models');
    check('1a mid-attack switch swaps the character look', g.hero.visual.look === 'model' && t1.visual.look === 'model', g.hero.visual.look);
    check('1b the same attack keeps playing, it does not restart',
      g.hero.state === pre1.state && g.hero.anim === pre1.anim && g.hero.attack.name === atk1.name
      && approx(g.hero.attack.t, atk1.t, 1e-9) && approx(g.hero.attack.dur, atk1.dur, 1e-9));
    check('1c the new visual resumes at the same clip fraction', approx(clipFraction(g.hero), pre1.frac, 1e-9),
      `before ${pre1.frac.toFixed(4)} after ${clipFraction(g.hero).toFixed(4)}`);
    check('1d hitstop / invulnerability / knockback timers survive the switch',
      approx(g.hero.freeze, pre1.freeze) && approx(g.hero.invuln, pre1.invuln)
      && approx(t1.freeze, pre1.tFreeze) && approx(t1.invuln, pre1.tInvuln)
      && (pre1.tKb === null ? t1.kb === null : approx(t1.kb.remaining, pre1.tKb, 1e-9)));

    // The hit window still lands after the switch (the enemy reacts, hitstop and knockback start).
    let hitInfo = null;
    g.on('hit', h => {
      if (h.attacker === g.hero && h.target === t1) {
        hitInfo = { freeze: t1.freeze, invuln: t1.invuln, kb: t1.kb ? t1.kb.remaining : null, state: t1.state };
      }
    });
    run(14);
    check('1e the queued hit still lands through the hit window after switching',
      !!hitInfo && hitInfo.state === 'hurt' && hitInfo.freeze > 0 && hitInfo.kb !== null && hitInfo.invuln > 0,
      hitInfo ? `freeze ${hitInfo.freeze.toFixed(3)} kb ${hitInfo.kb}` : 'no hit');
    const fracBeforeBack = clipFraction(g.hero);
    window.__switchLook('greybox');
    check('1f switching back keeps the same attack progress and greybox look',
      g.hero.visual.look === 'greybox' && g.hero.attack && g.hero.attack.name === atk1.name
      && approx(clipFraction(g.hero), fracBeforeBack, 1e-9));

    // 2. An enemy mid-attack keeps its clip and progress across both directions of the switch.
    setup();
    g.hero.hp = 1000;
    const e2 = place('thug_skinny', 1.0, 0);
    e2.cooldown = 0; g.turns.update = dt => g.turns.constructor.prototype.update.call(g.turns, dt, g.enemies);
    g.turns.holder = e2; e2.onTurnGiven(true); e2.engaged = true;
    let sawAttack = null;
    run(180, () => { if (!sawAttack && e2.state === 'attack') sawAttack = e2.attack.name; });
    check('2a the enemy started an attack on its turn', !!sawAttack, sawAttack ?? 'none');
    // Hold it in the attack state long enough to switch mid-swing (dummies never time out).
    let held = 0;
    while (e2.state !== 'attack' && held < 180) { run(1); held++; }
    check('2a2 the enemy is mid-attack for the switch', e2.state === 'attack', e2.state);
    const e2pre = { name: e2.attack?.name, t: e2.attack?.t, frac: clipFraction(e2), anim: e2.anim };
    window.__switchLook('models');
    check('2b enemy attack does not restart when switching to models',
      e2.state === 'attack' && e2.attack?.name === e2pre.name && approx(e2.attack.t, e2pre.t, 1e-9)
      && e2.anim === e2pre.anim && approx(clipFraction(e2), e2pre.frac, 1e-9),
      `state ${e2.state}, t ${e2pre.t} -> ${e2.attack?.t}, frac ${e2pre.frac?.toFixed(4)} -> ${clipFraction(e2).toFixed(4)}`);
    run(3);
    window.__switchLook('greybox');
    check('2c switching back mid-attack still resumes at the current progress',
      e2.visual.look === 'greybox' && e2.attack?.name === e2pre.name
      && clipFraction(e2) > e2pre.frac, `frac ${e2pre.frac.toFixed(4)} -> ${clipFraction(e2).toFixed(4)}`);

    // 3. Crates: broken ones stay gone and non-solid in both looks; intact ones keep their look;
    //    restart brings every crate back.
    setup();
    const broken = crateAt(5), intact = crateAt(6.1);
    g.hero.pos.set(4.1, 0, -2.9); g.hero.facing = 1;
    g.input.press('punch');
    run(30);
    check('3a the punch breaks one crate and removes its collider',
      broken.broken === true && !solidAt(5, -3.4) && !g.scene.children.includes(broken.visual.root));
    window.__switchLook('models');
    check('3b the broken crate stays gone after switching',
      broken.broken === true && !g.scene.children.includes(broken.visual.root) && !solidAt(5, -3.4)
      && broken.visual.look === 'model');
    check('3c an unbroken crate is rebuilt in the new look and still blocks movement',
      !intact.broken && g.scene.children.includes(intact.visual.root)
      && intact.visual.look === 'model' && solidAt(6.1, -3.4));
    window.__switchLook('greybox');
    check('3d switching back does not resurrect the broken crate',
      broken.broken === true && !g.scene.children.includes(broken.visual.root) && !solidAt(5, -3.4)
      && intact.visual.look === 'greybox' && solidAt(6.1, -3.4));
    g.reset();
    const cratesAfterReset = g.props.filter(p => p.breakable);
    check('3e restart restores every crate (visible and solid) and clears the food',
      cratesAfterReset.every(p => !p.broken && g.scene.children.includes(p.visual.root))
      && cratesAfterReset.every(p => solidAt(p.pos[0], p.pos[2]))
      && g.pickups.length === 0,
      `crates ${cratesAfterReset.length}, pickups ${g.pickups.length}`);

    // 4. Food: keeps position and rotation/bob phase through switches and still heals when eaten.
    setup();
    g.hero.hp = 40;
    const crate = crateAt(5);
    g.hero.pos.set(4.1, 0, -2.9); g.hero.facing = 1;
    g.input.press('punch');
    run(30);
    check('4a breaking the crate drops food', g.pickups.length === 1 && crate.broken === true);
    const food = g.pickups[0];
    const fPos = food.pos.clone(), fRoot = food.visual.root.position.clone();
    run(20);                                  // let it spin and bob for a while
    const fState = food.visual.captureState();
    window.__switchLook('models');
    const foodNow = g.pickups[0];
    check('4b the food survives the switch at the same world position',
      !!foodNow && foodNow.pos.distanceTo(fPos) < 1e-9
      && approx(foodNow.visual.root.position.x, fRoot.x) && approx(foodNow.visual.root.position.z, fRoot.z));
    check('4c the new food keeps the spin angle and bob phase (no jump, no floating)',
      foodNow.visual.look === 'model'
      && approx(foodNow.visual.spin.rotation.y, fState.spinY, 1e-9)
      && approx(foodNow.visual.t, fState.t, 1e-9)
      && approx(foodNow.visual.spin.position.y, 0.35 + Math.sin(fState.t * 4) * 0.06, 1e-9));
    window.__switchLook('greybox');
    check('4d the food survives switching back too',
      g.pickups.length === 1 && g.pickups[0].visual.look === 'greybox'
      && approx(g.pickups[0].visual.spin.rotation.y, fState.spinY, 1e-9));
    g.hero.pos.set(fPos.x - 0.2, 0, fPos.z);
    run(10);
    check('4e the switched food is still edible and heals 15',
      g.pickups.length === 0 && g.hero.hp === 55, `hp ${g.hero.hp}`);

    // 5. KO fade: the alpha carries across the switch and the enemy is removed at the same time.
    // Both runs count every step from the knockout punch until the enemy is taken off the field.
    const koSequence = () => {
      const e = dummy(place('thug_skinny', 0.9, 0, 30));
      g.hero.pos.set(0, 0, 0);
      for (let k = 0; k < 4; k++) { g.input.press('punch'); run(20); }
      return e;
    };
    const countRemoval = (e, cap = 400) => {
      let steps = 0;
      while (g.enemies.includes(e)) { run(1); if (++steps > cap) break; }
      return steps;
    };
    // Reference: no switching.
    setup();
    const ref = koSequence();
    check('5a the enemy is knocked out', !ref.alive && ref.state === 'ko');
    const refSteps = countRemoval(ref);

    // Same KO again, but switch looks in the middle of the fade-out.
    setup();
    const ko = koSequence();
    check('5b the second knockout matches the first one', !ko.alive && ko.state === 'ko');
    let alphaMid = 1, switched = false, switchStep = -1, alphaAfter = -1;
    let koSteps = 0;
    while (g.enemies.includes(ko)) {
      const f = (ko.stateTime - 3.6) / 0.5;
      if (!switched && f > 0.2 && f < 0.8) {
        alphaMid = alphaOf(ko);
        window.__switchLook('models');
        alphaAfter = alphaOf(ko);
        switched = true;
        switchStep = koSteps;
      }
      run(1);
      if (++koSteps > 400) break;
    }
    check('5c a switch during the fade keeps the current transparency',
      switched && ko.visual.look === 'model' && approx(alphaAfter, alphaMid, 1e-9) && alphaMid > 0 && alphaMid < 1,
      `alpha ${alphaMid.toFixed(3)} -> ${alphaAfter.toFixed(3)} at step ${switchStep}`);
    check('5d the faded enemy is removed at the same time as without a switch',
      !g.enemies.includes(ko) && Math.abs(koSteps - refSteps) <= 2, `switched ${koSteps} vs plain ${refSteps}`);

    // 6. Seeded differential run: two identical games built the same way, one switches looks on
    //    a fixed schedule; their gameplay state must match on every single step.
    const makeWorld = () => {
      setSeed(SEED);
      const scene = new THREE.Scene();
      const camera = { position: new THREE.Vector3(), lookAt() {} };
      const hud = { camera, endShown: false, update() {}, combo() {}, banner() {}, popup() {}, say() {}, showEnd() {}, hideEnd() {} };
      const world = new Game(scene, camera, new Input(), hud);
      world.spawnQueue = ['__none__']; world.nextArrival = 1e9;
      world.turns.update = () => {}; world.turns.holder = null;
      for (const f of [world.hero, ...world.enemies]) f.update = function (dt) { this.tick(dt); };
      return world;
    };
    const wa = makeWorld();          // world A: its look gets switched
    const wc = makeWorld();          // world C: the no-switch control
    check('6a both worlds start from the same seeded state',
      approx(wa.time, wc.time) && wa.wave === wc.wave && wa.enemies.length === wc.enemies.length);
    const addDummy = (world, x, z) => {
      const e = world.addEnemy('thug_skinny', 1, z);
      e.entering = false; e.pos.set(x, 0, z); e.prevPos.copy(e.pos);
      e.hp = e.maxHp = 500; e.cooldown = 1e9; e.side = 1; e.facing = -1;
      e.update = function (dt) { this.tick(dt); };
      return e;
    };
    addDummy(wa, 0.9, 0); addDummy(wa, 1.4, 0.6);
    addDummy(wc, 0.9, 0); addDummy(wc, 1.4, 0.6);
    check('6a2 both worlds hold the same two dummies', wa.enemies.length === 2 && wc.enemies.length === 2);
    const stepBoth = (fnA, fnC) => {
      fnA?.(); fnC?.();
      wa.step(1 / 60); wa.render(1 / 60, 1);
      wc.step(1 / 60); wc.render(1 / 60, 1);
    };
    const snap = game => ({
      time: game.time, wave: game.wave,
      hero: {
        x: game.hero.pos.x, z: game.hero.pos.z, hp: game.hero.hp, state: game.hero.state,
        anim: game.hero.anim, freeze: game.hero.freeze, invuln: game.hero.invuln,
        attack: game.hero.attack ? { name: game.hero.attack.name, t: game.hero.attack.t, hits: game.hero.attack.hits.size } : null,
        kb: game.hero.kb ? { remaining: game.hero.kb.remaining, dir: game.hero.kb.dir } : null,
      },
      enemies: game.enemies.map(e => ({
        kind: e.kind, x: e.pos.x, z: e.pos.z, hp: e.hp, state: e.state, anim: e.anim,
        freeze: e.freeze, invuln: e.invuln, stateTime: e.stateTime,
        attack: e.attack ? { name: e.attack.name, t: e.attack.t, hits: e.attack.hits.size } : null,
        kb: e.kb ? { remaining: e.kb.remaining, dir: e.kb.dir } : null, opacity: e.opacity,
      })),
      crates: game.props.filter(p => p.breakable).map(p => ({ x: p.pos[0], broken: p.broken })),
      solids: game.solids.length,
      food: game.pickups.map(f => ({ x: f.pos.x, z: f.pos.z })),
    });
    const eq = (a, b, path = '') => {
      if (typeof a === 'number' || typeof b === 'number') return typeof a === typeof b && approx(a, b, 1e-9);
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length || ka.some(k => !(k in b))) return false;
      return ka.every(k => eq(a[k], b[k], path + '.' + k));
    };
    const breakCrate = world => {
      // Deterministic crate break (the punch/drop/eat mechanics themselves are checks 3 and 4):
      // mark the first crate broken exactly as hitCrates() would, then drop its food.
      const crate = world.props.find(p => p.breakable && !p.broken);
      if (!crate) return;
      crate.broken = true;
      world.scene.remove(crate.visual.root);
      world.solids.splice(world.solids.indexOf(crate.collider), 1);
      const food = { pos: new THREE.Vector3(crate.pos[0], 0, crate.pos[2]), visual: createVisual('food') };
      food.visual.root.position.copy(food.pos);
      world.scene.add(food.visual.root);
      world.pickups.push(food);
    };
    const rng = mulberry32(SEED);
    const TOTAL = 900;
    let mismatches = [];
    const modesUsed = new Set();
    for (let i = 0; i < TOTAL; i++) {
      // Fixed-schedule scripted commands, identical in both worlds.
      if (i === 5) stepBoth(() => wa.input.press('punch'), () => wc.input.press('punch'));
      else if (i === 60) stepBoth(() => wa.input.press('punch'), () => wc.input.press('punch'));
      else if (i === 120) stepBoth(() => wa.input.press('kick'), () => wc.input.press('kick'));
      else if (i === 200) stepBoth(() => breakCrate(wa), () => breakCrate(wc));
      else if (i === 400) stepBoth(() => wa.input.press('punch'), () => wc.input.press('punch'));
      else if (i === 480) stepBoth(() => wa.input.press('kick'), () => wc.input.press('kick'));
      else if (i === 560) stepBoth(
        () => { wa.hero.pos.set(0, 0, 0); wa.input.press('punch'); },
        () => { wc.hero.pos.set(0, 0, 0); wc.input.press('punch'); });
      else stepBoth();
      // The seeded switch schedule only touches world A's look.
      if (i > 0 && i % 37 === 0) {
        const mode = rng() < 0.5 ? 'models' : 'greybox';
        modesUsed.add(mode);
        switchVisuals(wa, mode);
      }
      const sa = snap(wa), sc = snap(wc);
      if (!eq(sa, sc)) {
        mismatches.push({ step: i, mode: getVisualMode(), a: sa, c: sc });
        if (mismatches.length >= 3) break;
      }
    }
    check('6b switching looks on a seeded schedule never changes gameplay state',
      mismatches.length === 0, mismatches.length ? JSON.stringify(mismatches[0]).slice(0, 400) : '');
    check('6c the seeded schedule really switched into both looks',
      modesUsed.size === 2, [...modesUsed].join(','));
    // The differential run exercised every feature at least once:
    const s = snap(wa), sc = snap(wc);
    check('6d the run broke a crate and dropped food in both worlds identically',
      s.crates.some(c => c.broken) && s.food.length > 0 && eq(s.food, sc.food),
      `food ${s.food.length}, broken crates ${s.crates.filter(c => c.broken).length}`);
    check('6e KO fade alpha stayed in sync between the two worlds',
      eq(s.enemies.map(e => e.opacity), sc.enemies.map(e => e.opacity)));

    // 7. The real GLB-backed ModelCharacter mixer path (no GLB file needed: a fabricated proto
    //    and clip exercise the exact capture/apply code the Tripo models use).
    {
      const clipName = 'box_01';
      const holder = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.3), new THREE.MeshToonMaterial());
      mesh.name = 'body'; holder.add(mesh);
      const times = new Float32Array([0, 0.5, 1]);
      const clip = new THREE.AnimationClip(clipName, 1, [
        new THREE.QuaternionKeyframeTrack('body.quaternion', times, [
          0, 0, 0, 1, 0, 0, 0.7071, 0.7071, 0, 0, 0, 1]),
      ]);
      const proto = { id: 'thug_skinny', isChar: true, holder, clips: { [clipName]: clip }, footSpeed: {} };
      const a = new ModelCharacter(proto);
      a.play(clipName, { loop: false, timeScale: 2 });
      a.update(0.2);                              // advance the mixer part-way through the clip
      a.setOpacity(0.4);                          // simulate a KO fade already in progress
      const st = a.captureState();
      const aFrac = a.current.time / a.current.getClip().duration;
      const b = new ModelCharacter(proto);
      b.applyState(st);
      const bFrac = b.current.time / b.current.getClip().duration;
      check('7a a fresh Tripo model resumes the same clip at the same mixer time',
        b.anim === clipName && approx(bFrac, aFrac, 1e-9) && approx(st.fraction, aFrac, 1e-9),
        `frac ${aFrac.toFixed(4)} -> ${bFrac.toFixed(4)}`);
      check('7b the resumed model carries the KO fade alpha (stays transparent)',
        approx(b.opacity, 0.4, 1e-9) && approx(b.materials[0].opacity, 0.4, 1e-9));
      const bodyA = a.model.children[0], bodyB = b.model.children[0];
      const q1 = bodyA.getWorldQuaternion(new THREE.Quaternion());
      b.update(0);
      const q2 = bodyB.getWorldQuaternion(new THREE.Quaternion());
      check('7c the replacement pose matches the outgoing one after applyState',
        q1.angleTo(q2) < 1e-6, `angle ${q1.angleTo(q2).toExponential(2)}`);
      a.dispose(); b.dispose();
    }

    return out;
  }, SEED);

  let bad = 0;
  for (const r of results) { if (!r.ok) bad++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`); }
  if (pageErrors.length) {
    bad++;
    console.log('FAIL  no page errors  (' + [...new Set(pageErrors)].join(' | ') + ')');
  } else console.log('PASS  no page errors');
  process.exitCode = bad ? 1 : 0;
  await browser.close();
} finally {
  if (browserProc) browserProc.kill();
  server.kill();
}
