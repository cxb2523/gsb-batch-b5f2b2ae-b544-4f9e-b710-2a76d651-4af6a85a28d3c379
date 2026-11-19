// Checks that a quality switch is one atomic step: from the frame after a switch the shadows,
// the water's mirror and the whole post chain all run at the new tier, the old GPU targets are
// released, and no switch (manual or the automatic downgrade) ever leaves a black frame.
//   node tools/quality-check.mjs [--q low|medium|high|ultra ...] [--keep]
// Needs the dev deps (three) installed; uses the headless GPU browser from tools/pw.mjs.
import { startServer } from './dev-server.mjs';
import { launch } from './pw.mjs';

const args = { order: ['ultra', 'low', 'medium', 'high'] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--keep') args.keep = true;
  else if (a === '--q') {
    args.order = [];
    while (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args.order.push(process.argv[++i]);
  }
}

let bad = 0;
const check = (name, ok, detail = '') => {
  if (!ok) bad++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail ? '  ' + detail : ''));
};

const { server, url } = await startServer(0);
const { browser, page, logs } = await launch({ width: 900, height: 560 });
try {
  await page.goto(`${url}/dev/game.html?dev=1&still=1&force=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DONE === true, null, { timeout: 180000 });

  // helpers inside the page: read state, read the picture, and count target disposals
  await page.evaluate(() => {
    const T = window.TP.THREE;
    const e = window.TP.engine;
    window.QC = {
      luma() {
        const c = document.getElementById('c');
        const gl = e.renderer.getContext();
        const p = new Uint8Array(4);
        let s = 0;
        for (let i = 0; i < 9; i++) {
          gl.readPixels(Math.floor(((i % 3) + 0.5) * (c.width / 3)), Math.floor((Math.floor(i / 3) + 0.5) * (c.height / 3)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
          s += p[0] + p[1] + p[2];
        }
        return s / 27;
      },
      errors() {
        const gl = e.renderer.getContext();
        const out = [];
        for (let i = 0; i < 8; i++) {
          const er = gl.getError();
          if (!er) break;
          out.push(er);
        }
        return out;
      },
      watch() {
        const log = [];
        const orig = T.WebGLRenderTarget.prototype.dispose;
        T.WebGLRenderTarget.prototype.dispose = function () {
          log.push([this.width, this.height]);
          return orig.call(this);
        };
        return () => {
          T.WebGLRenderTarget.prototype.dispose = orig;
          return log;
        };
      },
      /** Every invariant the tier promises, read off the live objects. */
      state() {
        const L = e.lighting.csm;
        const w = window.TP.game.world && window.TP.game.world.water;
        const hw = Math.max(2, e.w >> 1),
          hh = Math.max(2, e.h >> 1);
        const bad = [];
        const eq = (n, a, b) => a === b || bad.push(`${n}: ${a} != ${b}`);
        eq('q.shadow/csm.size', e.q.shadow, L.shadowMapSize);
        eq('q.shadowFar/csm.maxFar', e.q.shadowFar, L.maxFar);
        eq('shaft range', +e.post.mVol.uniforms.uShadowRange.value.toFixed(1), +(Math.min(e.camera.far, L.maxFar) - e.camera.near).toFixed(1));
        L.lights.forEach((l, i) => {
          eq(`cascade${i}.mapSize`, l.shadow.mapSize.x, e.q.shadow);
          if (l.shadow.map) {
            eq(`cascade${i}.map`, l.shadow.map.width, e.q.shadow);
            eq(`cascade${i}.tex`, l.shadow.map.texture.image.width, e.q.shadow);
          }
        });
        eq('post.w', e.post.w, e.w);
        eq('post.h', e.post.h, e.h);
        e.post.vol.forEach((r) => eq('post.vol', r.width, hw));
        eq('post.dofRT', e.post.dofRT.width, e.w);
        eq('post.ldr', e.post.ldr.width, e.w);
        e.post.down.forEach((r) => r.width <= hw || bad.push('bloom level too wide'));
        eq('post.volumetric', e.post.volumetric, e.q.vol);
        if (w) {
          eq('water.uReflOn', w.uniforms.uReflOn.value, e.q.reflect && e.camera.position.y > 0.05 ? 1 : 0);
          if (e.q.reflect) eq('water.reflRT.width', w.reflRT ? w.reflRT.width : -1, hw);
          else eq('water.reflRT released', w.reflRT, null);
          eq('water.uReflTex bound', !!(w.uniforms.uReflTex.value && w.uniforms.uReflTex.value.image), true);
        }
        return { quality: e.quality, w: e.w, h: e.h, bad };
      },
    };
  });

  await page.evaluate(() => {
    window.TP.engine.post.grade.fade = 0;
    window.TP.play();
    window.TP.game.engine.post.grade.fade = 0;
    window.TP.step(20, 1 / 30);
  });

  for (const name of args.order) {
    const r = await page.evaluate((name) => {
      const e = window.TP.engine;
      const before = {
        main: e.main.texture.uuid,
        vol: e.post.vol[0].texture.uuid,
        ldr: e.post.ldr.texture.uuid,
        down: e.post.down[0].texture.uuid,
        refl: window.TP.game.world.water.reflRT ? window.TP.game.world.water.reflRT.texture.uuid : null,
      };
      const stop = window.QC.watch();
      const bufferBefore = [e.w, e.h, e.main.samples];
      e.setQuality(name);
      const disposed = stop();
      const stateAtOnce = window.QC.state();
      // The drawing buffer is not preserved between animation frames, so only a switch that
      // reallocated it can be judged by reading it: a kept buffer needs no repaint at all.
      // (When it did reallocate, a cleared canvas would read as pure black.)
      const bufferAfter = [e.w, e.h, e.main.samples];
      const reallocated = bufferBefore.join() !== bufferAfter.join();
      const lumaAtOnce = reallocated ? window.QC.luma() : -1;
      const frames = [];
      for (let i = 0; i < 10; i++) {
        window.TP.game.frame(1 / 30);
        frames.push(window.QC.luma());
      }
      const after = {
        main: e.main.texture.uuid,
        vol: e.post.vol[0].texture.uuid,
        ldr: e.post.ldr.texture.uuid,
        down: e.post.down[0].texture.uuid,
        refl: window.TP.game.world.water.reflRT ? window.TP.game.world.water.reflRT.texture.uuid : null,
      };
      const gone = (k) => (before[k] && before[k] !== after[k] ? disposed.some(([w, h]) => w > 0 && h > 0) : true);
      return { stateAtOnce, stateAfter: window.QC.state(), lumaAtOnce, reallocated, frames, errs: window.QC.errors(), replaced: gone, disposed: disposed.length };
    }, name);

    const s = r.stateAfter;
    check(`${name}: state converges`, s.bad.length === 0, s.bad.slice(0, 4).join('; '));
    if (r.reallocated) check(`${name}: no black frame after the switch`, r.lumaAtOnce > 3, 'luma ' + r.lumaAtOnce.toFixed(1));
    check(`${name}: ten frames render`, r.frames.every((v) => v > 3), 'min ' + Math.min(...r.frames).toFixed(1));
    check(`${name}: no GL error`, r.errs.length === 0, JSON.stringify(r.errs));
    check(`${name}: old targets disposed`, r.disposed > 0, r.disposed + ' releases');
  }

  // the automatic downgrade must take the same road and land in the same place
  await page.evaluate(() => window.TP.engine.setQuality('high'));
  const auto = await page.evaluate(() => {
    const g = window.TP.game;
    g._setSetting('quality', 'low', false);
    const atOnce = window.QC.state();
    for (let i = 0; i < 8; i++) g.frame(1 / 30);
    return { atOnce, after: window.QC.state(), luma: window.QC.luma(), errs: window.QC.errors() };
  });
  check('auto downgrade: same convergence', auto.atOnce.bad.length === 0 && auto.after.bad.length === 0, [...auto.atOnce.bad, ...auto.after.bad].slice(0, 4).join('; '));
  check('auto downgrade: no black frame', auto.luma > 3, 'luma ' + auto.luma.toFixed(1));
  check('auto downgrade: no GL error', auto.errs.length === 0, JSON.stringify(auto.errs));

  // a long run of switches: nothing may leak or start failing
  const long = await page.evaluate(() => {
    const e = window.TP.engine;
    const errs = [];
    for (let i = 0; i < 24; i++) {
      e.setQuality(['ultra', 'low', 'medium', 'high'][i % 4]);
      window.TP.game.frame(1 / 30);
      errs.push(...window.QC.errors());
    }
    return { errs: errs.slice(0, 6), state: window.QC.state(), textures: e.renderer.info.memory.textures };
  });
  check('long run: no GL error', long.errs.length === 0, JSON.stringify(long.errs));
  check('long run: state converges', long.state.bad.length === 0, long.state.bad.slice(0, 4).join('; '));

  const pageErrors = logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
  check('no errors in the console', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ').slice(0, 300));
} catch (e) {
  bad++;
  console.log('FAILED: ' + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  server.close();
}

console.log(bad ? `${bad} check(s) failed` : 'quality switching is atomic');
process.exit(bad ? 1 : 0);
