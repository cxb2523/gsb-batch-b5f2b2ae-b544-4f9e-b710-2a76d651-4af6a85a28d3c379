/* The state invariants, asserted in the page that ships them.
 *
 * The Node walker (`tools/_walktest.mjs`) proves the arithmetic over the whole
 * route in a second, but it runs a *copy* of `step` and `placeAt`, because
 * `main.js` owns a canvas. The properties the task names — a teleport clearing
 * the settle so the camera does not dip, two renders in a row being
 * pixel-identical, two teleports matching one — are properties of the page, and
 * only the page can be asked about them.
 *
 * This drives the real key handlers and the real `walkTo`, and reads back the
 * real camera and the real framebuffer. It is deliberately separate from
 * `tools/_jump.mjs`, which measures how a jump *feels*: this one measures that
 * the four invariants hold, and it says which one broke when one does.
 *
 *   node tools/_state.mjs              # 1280x720, the fastest useful size
 *   node tools/_state.mjs --big        # 2560x1440, what the record is shot at
 */
import { run } from './harness.mjs';

const BIG = process.argv.includes('--big');
const W = BIG ? 2560 : 1280, H = BIG ? 1440 : 720;

let fails = 0;
const check = (ok, name, detail) => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
};

await run({ width: W, height: H, hash: 'high' }, async ({ page, errs }) => {
  await page.waitForTimeout(1500);

  /* ── readbacks ────────────────────────────────────────────────────────── */
  const readPlayer = () => page.evaluate(() => {
    const p = window.__game._player;
    return { x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz, vy: p.vy,
             air: p.air, settle: p.settle, settleV: p.settleV,
             bob: p.bob, bob0: p.bob0 };
  });
  const readState = () => page.evaluate(() => {
    const g = window.__game, s = g._state, p = g._player;
    const q = g._path.atZ(p.z, {});
    return {
      corridor: s.corridor,
      lift: s.lift,
      bobPhase: s.bobPhase,
      ground: g._terrain.heightAtQ(p.x, p.z, q),
    };
  });
  /* Two renders of the same paused frame, read back in the same task each. The
     renderer has no preserveDrawingBuffer, so the read has to happen before the
     next task or the buffer is gone. */
  const twoFrames = () => page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    const gl = g.renderer.getContext();
    const cv = g.renderer.domElement;
    const w = cv.width, h = cv.height;
    const a = new Uint8Array(w * h * 4), b = new Uint8Array(w * h * 4);
    g.renderOnce();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);
    g.renderOnce();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    g.setPaused(false);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diff++; break; }
    return { identical: diff === 0, w, h };
  });
  const cameraMatrix = () => page.evaluate(() => {
    window.__game._camera.updateMatrixWorld(true);
    return Array.from(window.__game._camera.matrixWorld.elements);
  });

  const settleFrames = async (n = 40) => page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r));
  }, n);

  console.log(`\n  state invariants at ${W}x${H}\n`);

  /* ── 1. the fixed point ────────────────────────────────────────────────
   * No key held. This is the baseline the whole capture record rests on. */
  await page.evaluate(() => { window.__game.walkTo(46); window.__game.lookAt(0, 0); });
  await settleFrames();
  {
    const f = await twoFrames();
    check(f.identical, 'two renders at rest are pixel-identical',
          `${f.w}x${f.h}`);
  }

  /* ── 2. the corridor invariant, walking and jumping ────────────────────
   * Strafe hard into each wall for a few seconds and press Space, reading the
   * corridor state on every sampled frame. `|u| <= lim` is the invariant; the
   * `over` reported is the worst margin. */
  for (const [d, key] of [[8, 'd'], [46, 'a'], [120, 'd'], [220, 'a'], [300, 'd']]) {
    await page.evaluate((d) => { window.__game.walkTo(d); window.__game.lookAt(0, 0); }, d);
    await settleFrames(20);
    await page.keyboard.down(key);
    await page.keyboard.down('Shift');
    await page.keyboard.down('Control');
    const worst = await page.evaluate(async () => {
      const g = window.__game;
      let worstOver = -Infinity, n = 0, out = 0;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => requestAnimationFrame(r));
        const c = g._state.corridor;
        const over = c.over;
        if (over > worstOver) worstOver = over;
        if (over > 1e-6) out++;
        n++;
      }
      return { worstOver, n, out };
    });
    await page.keyboard.up('Control');
    await page.keyboard.up('Shift');
    await page.keyboard.up(key);
    check(worst.out === 0, `strafing ${key.toUpperCase()} at d=${d} stays inside`,
          `worst margin ${(worst.worstOver * 100).toFixed(3)} cm over ${worst.n} frames`);
  }

  /* And while jumping: the case the task singles out, where an airborne push
   * could put a frame inside the rock. */
  for (const [d, key] of [[46, 'd'], [120, 'a'], [220, 'd']]) {
    await page.evaluate((d) => { window.__game.walkTo(d); window.__game.lookAt(0, 0); }, d);
    await settleFrames(20);
    await page.keyboard.down(key);
    await page.keyboard.down('Shift');
    await page.keyboard.down('Control');
    let out = 0, worstOver = -Infinity, airFrames = 0;
    for (let jump = 0; jump < 6; jump++) {
      await page.keyboard.down('Space');
      await page.waitForTimeout(60);
      await page.keyboard.up('Space');
      const r = await page.evaluate(async () => {
        const g = window.__game;
        let o = 0, w = -Infinity, a = 0;
        for (let i = 0; i < 45; i++) {
          await new Promise(r => requestAnimationFrame(r));
          const c = g._state.corridor;
          if (c.over > w) w = c.over;
          if (c.over > 1e-6) o++;
          if (g._player.air) a++;
        }
        return { o, w, a };
      });
      out += r.o; worstOver = Math.max(worstOver, r.w); airFrames += r.a;
    }
    await page.keyboard.up('Control');
    await page.keyboard.up('Shift');
    await page.keyboard.up(key);
    check(out === 0, `jumping at the wall d=${d} ${key.toUpperCase()} stays inside`,
          `${airFrames} airborne samples, worst margin ${(worstOver * 100).toFixed(3)} cm`);
  }

  /* ── 3. a constrained jump lands on the ground and its spring finishes ──
   * Speed is not zeroed by the projection, the landing height is the height
   * under the landing point, and the spring returns to exactly zero. */
  await page.evaluate(() => { window.__game.walkTo(46); window.__game.lookAt(62, 0); });
  await settleFrames(20);
  await page.keyboard.down('d');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Control');
  await page.waitForTimeout(1200);               // strafe to the wall
  await page.keyboard.down('Space');
  await page.waitForTimeout(60);
  await page.keyboard.up('Space');
  const air = await page.evaluate(async () => {
    const g = window.__game, p = g._player;
    let airFrames = 0, maxSpeed = 0, minVy = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (p.air) {
        airFrames++;
        maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vz));
        minVy = Math.min(minVy, p.vy);
      }
      if (!p.air && airFrames > 0) break;
    }
    return { airFrames, maxSpeed, minVy };
  });
  await page.keyboard.up('Control');
  await page.keyboard.up('Shift');
  await page.keyboard.up('d');
  /* Long enough for the spring to finish, not just to be small. The snap to
     zero needs both terms under 1e-4, and a turbo landing hands the spring
     about 0.65 m/s; e^-8t takes that past the threshold at about 1.1 s, so
     1.2 s was measuring the curve and not the finish. */
  await page.waitForTimeout(2500);
  const land = await page.evaluate(() => {
    const g = window.__game, p = g._player;
    const q = g._path.atZ(p.z, {});
    return { dy: p.y - g._terrain.heightAtQ(p.x, p.z, q),
             settle: p.settle, settleV: p.settleV, air: p.air };
  });
  check(!land.air && Math.abs(land.dy) < 1e-9 && land.settle === 0 && land.settleV === 0,
        'a jump into the wall lands on the ground and settles to zero',
        `airtime ${(air.airFrames / 60).toFixed(2)} s, speed kept ${air.maxSpeed.toFixed(1)} m/s, ` +
        `dy=${land.dy.toExponential(1)} settle=${land.settle}`);

  /* ── 4. a teleport clears the whole arrival, from mid-flight ──────────── */
  await page.evaluate(() => { window.__game.walkTo(46); window.__game.lookAt(0, 0); });
  await settleFrames(20);
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.down('Space');
  await page.waitForTimeout(60);
  await page.keyboard.up('Space');
  await page.keyboard.up('w');
  await page.waitForTimeout(100);
  const tele = await page.evaluate(() => {
    const g = window.__game;
    const wasAir = g._player.air;
    g.walkTo(120);
    const p = g._player, s = g._state;
    return { wasAir, air: p.air, vy: p.vy, settle: p.settle, settleV: p.settleV,
             bob: p.bob, bob0: s.bobPhase, lift: s.lift,
             ground: p.y - g._terrain.heightAtQ(p.x, p.z, g._path.atZ(p.z, {})),
             cor: s.corridor };
  });
  const clean = tele.air === false && tele.vy === 0 && tele.settle === 0 &&
    tele.settleV === 0 && tele.bob === 0 && tele.bob0 === 0 && tele.lift === 0 &&
    Math.abs(tele.ground) < 1e-9 && tele.cor.inCorridor;
  check(clean, 'walkTo mid-flight clears air, settle, bob, lift and grounds',
        `${tele.wasAir ? 'was airborne' : 'was grounded'}: air=${tele.air} vy=${tele.vy} ` +
        `settle=${tele.settle} bob0=${tele.bob0} lift=${tele.lift} ` +
        `|u|=${Math.abs(tele.cor.u).toFixed(2)}/${tele.cor.lim.toFixed(2)}`);

  /* And two teleports in quick succession are the same frame as one. */
  const twice = await (async () => {
    await page.evaluate(() => { window.__game.walkTo(46); window.__game.lookAt(0, 0); });
    await settleFrames(15);
    await page.evaluate(() => { window.__game.walkTo(120); window.__game.walkTo(220); window.__game.lookAt(0, 2); });
    await settleFrames(15);
    const m = await cameraMatrix();
    const f = await twoFrames();
    return { m, f };
  })();
  const once = await (async () => {
    await page.evaluate(() => { window.__game.walkTo(220); window.__game.lookAt(0, 2); });
    await settleFrames(15);
    const m = await cameraMatrix();
    const f = await twoFrames();
    return { m, f };
  })();
  const sameM = JSON.stringify(twice.m) === JSON.stringify(once.m);
  check(sameM && twice.f.identical && once.f.identical,
        'walkTo(46) then walkTo(220) matches walkTo(220)',
        sameM ? 'camera matrix bit-identical' : 'camera matrix differs');

  /* ── 5. the fixed point, after all of the above ────────────────────────
   * The same framing, twice, with no key held, must still be two identical
   * frames — a teleport and a jump must not have left a settling spring or a
   * frozen clock behind. */
  await page.evaluate(() => { window.__game.walkTo(46); window.__game.lookAt(0, 0); });
  await settleFrames();
  {
    const f = await twoFrames();
    check(f.identical, 'and the fixed point survives every path above',
          `${f.w}x${f.h}`);
  }

  if (errs.length) {
    console.log('\n  page errors:');
    for (const e of errs.slice(0, 8)) console.log('   ', e);
  }
});

console.log(`\n  ${fails ? `${fails} FAILED` : 'all ok'}\n`);
process.exit(fails ? 1 : 0);
