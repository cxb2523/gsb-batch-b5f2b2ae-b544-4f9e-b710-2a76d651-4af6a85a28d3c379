// FX/오디오 생명주기 스모크 테스트:
// 1) FX 임시 오브젝트 추적·일괄 정리(멱등) 2) 일시정지 중 새 FX 미생성 + 트윈/BGM 정지·재개
// 3) 피해 숫자 토글 즉시 적용 + 잔여 숫자 제거 4) 테마 전환 시 구 노드 정리 5) music.stop/clearAll 반복 호출 안전
// 실행: npm run build && node server/index.mjs 띄운 뒤  node tools/fx-smoke.mjs
//   CDP=http://127.0.0.1:9229 처럼 기존 Chrome 디버그 엔드포인트를 지정할 수도 있다.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const URL = process.env.URL || 'http://127.0.0.1:4173/';
let chrome = null;
let cdpUrl = process.env.CDP || '';
if (!cdpUrl) {
  // Chrome 157+: CDP는 사전에 존재하는 비기본 프로필 디렉터리가 필요
  const PROF = 'D:/tmp-eclipse-fx-prof';
  fs.rmSync(PROF, { recursive: true, force: true }); fs.mkdirSync(PROF, { recursive: true });
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless', '--disable-gpu', '--remote-debugging-port=9225', `--user-data-dir=${PROF}`,
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome?.kill(); } catch { /* */ } });
  cdpUrl = 'http://127.0.0.1:9225';
}
let browser = null; let lastErr = null;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    // Chrome 157은 /json/version/ (슬래시 포함) 에 404를 반환하므로 ws URL을 직접 얻는다
    const ver = await (await fetch(cdpUrl.replace(/\/$/, '') + '/json/version')).json();
    browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
  } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500)); }
}
if (!browser) { console.log('FATAL: cannot connect to Chrome CDP', String(lastErr).slice(0, 400)); chrome?.kill(); process.exit(1); }
const page = (await browser.contexts()[0].pages())[0] || await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

await page.goto(URL + '?debug', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// 게스트 새 게임 → 바로 월드 진입
await page.evaluate(() => document.querySelector('[data-a="guestNew"]').click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('[data-a="ccClass:ranger"]').click());
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('[data-a="ccCreate"]').click());
await page.waitForFunction(() => { const w = window.__game?.scene.getScene('World'); return w && w.scene.isActive() && w.player; }, null, { timeout: 15000 });
await page.waitForTimeout(1500);
// 대화창이 떠 있으면 닫기
await page.evaluate(() => window.__dbg.UI.close(true));
await page.waitForTimeout(300); // 일시정지 해제 프레임 대기

const W = `window.__game.scene.getScene('World')`;

// --- 1) FX 추적 + 일괄 정리 멱등 ---
const t1 = await page.evaluate(`(() => { const w = ${W};
  w.fx.sprite('fx_circle', 100, 100, {}); w.fx.dmgText(100, 100, '123', '#fff'); w.fx.label(100, 100, 'hi');
  const n = w.fx.pool.size;
  w.fx.clearAll(); const a = w.fx.pool.size;
  w.fx.clearAll(); const b = w.fx.pool.size; // 두 번째 호출도 예외 없이
  return { n, a, b }; })()`);
check('FX tracked & clearAll idempotent', t1.n >= 3 && t1.a === 0 && t1.b === 0, JSON.stringify(t1));

// --- 2) 일시정지: 새 FX 미생성, 트윈/BGM 정지 → 재개 ---
await page.evaluate(`window.__dbg.UI.open('menu')`);
await page.waitForTimeout(400);
const t2 = await page.evaluate(`(() => { const w = ${W}; const m = window.__dbg.music;
  const before = w.fx.pool.size;
  const r1 = w.fx.sprite('fx_circle', 100, 100, {});
  w.fx.dmgText(100, 100, '9', '#fff'); w.fx.label(100, 100, 'x');
  return { paused: w.isPaused, fxPaused: w.fx.paused, ts: w.tweens.timeScale, timeTs: w.time.timeScale,
    musicPaused: m.paused, musicTimer: !!m.timer, grew: w.fx.pool.size - before, r1null: r1 === null }; })()`);
check('pause blocks new FX & stops tweens/music', t2.paused && t2.fxPaused && t2.ts === 0 && t2.timeTs === 0 && t2.musicPaused && !t2.musicTimer && t2.grew === 0 && t2.r1null, JSON.stringify(t2));
await page.evaluate(`window.__dbg.UI.close(true)`);
await page.waitForTimeout(400);
const t3 = await page.evaluate(`(() => { const w = ${W}; const m = window.__dbg.music;
  return { paused: w.isPaused, musicPaused: m.paused, musicTimer: !!m.timer, ts: w.tweens.timeScale }; })()`);
check('resume restores FX/tweens/music', !t3.paused && !t3.musicPaused && t3.musicTimer && t3.ts === 1, JSON.stringify(t3));

// --- 3) 피해 숫자 토글: 끄는 순간 잔여 제거 + 신규 미생성 ---
await page.evaluate(`(() => { const w = ${W}; w.fx.dmgText(200, 200, '55', '#fff'); })()`);
await page.waitForTimeout(100);
const t4a = await page.evaluate(`${W}.fx.dmgPool.size`);
await page.evaluate(`window.__dbg.UI.open('settings')`);
await page.waitForTimeout(300);
await page.evaluate(() => { const c = document.querySelector('[data-s="dmgNumbers"]'); if (c.checked) c.click(); });
await page.waitForTimeout(200);
const t4b = await page.evaluate(`(() => { const w = ${W};
  w.fx.dmgText(200, 200, '77', '#fff');
  return { pool: w.fx.dmgPool.size, setting: window.__dbg.st.S.settings.dmgNumbers }; })()`);
check('dmgNumbers toggle clears residual & blocks new', t4a > 0 && t4b.pool === 0 && t4b.setting === false, `before=${t4a} after=${JSON.stringify(t4b)}`);
await page.evaluate(() => { const c = document.querySelector('[data-s="dmgNumbers"]'); if (!c.checked) c.click(); }); // 원복
await page.evaluate(`window.__dbg.UI.close(true)`);
await page.waitForTimeout(300);

// --- 4) 씬 전환: 테마 교체(구 노드 정리) + music.stop 멱등 ---
const t5a = await page.evaluate(`window.__dbg.music.theme`);
await page.evaluate(`${W}.travel({ mode: 'field', ch: 2 })`);
await page.waitForTimeout(2000);
const t5b = await page.evaluate(`(() => { const m = window.__dbg.music; return { theme: m.theme, nodes: m.nodes.length, timer: !!m.timer }; })()`);
check('theme switches on scene change', t5a !== t5b.theme && t5b.nodes > 0 && t5b.timer, `${t5a} -> ${JSON.stringify(t5b)}`);
const t5c = await page.evaluate(`(() => { const m = window.__dbg.music;
  try { m.stop(); m.stop(); m.pause(); m.pause(); m.resume(); m.resume(); return { ok: true, theme: m.theme, nodes: m.nodes.length }; }
  catch (e) { return { ok: false, err: String(e) }; } })()`);
check('music stop/pause/resume idempotent', t5c.ok && t5c.theme === '' && t5c.nodes === 0, JSON.stringify(t5c));
// stop 이후 다음 씬에서 음악이 다시 켜지는지
await page.evaluate(`${W}.travel({ mode: 'town', ch: 1 })`);
await page.waitForTimeout(2000);
const t5d = await page.evaluate(`(() => { const m = window.__dbg.music; return { theme: m.theme, timer: !!m.timer }; })()`);
check('music restarts after stop + travel', t5d.theme !== '' && t5d.timer, JSON.stringify(t5d));

// --- 5) 광과민 모드: 섬광/흔들림 차단, 일반 FX는 유지 ---
const t6 = await page.evaluate(`(() => { const w = ${W}; const st = window.__dbg.st.S.settings;
  st.photosensitive = true;
  const cam = w.cameras.main; let flashes = 0, shakes = 0;
  const of = cam.flash.bind(cam), os = cam.shake.bind(cam);
  cam.flash = (...a) => { flashes++; return of(...a); }; cam.shake = (...a) => { shakes++; return os(...a); };
  w.fx.flashScreen(0xffffff, 100); w.fx.shake(100, 0.01);
  const before = w.fx.pool.size; w.fx.burst(300, 300, 0xffffff, 50); const normal = w.fx.pool.size - before;
  cam.flash = of; cam.shake = os; st.photosensitive = false;
  return { flashes, shakes, normal }; })()`);
check('photosensitive blocks flash/shake, keeps normal FX', t6.flashes === 0 && t6.shakes === 0 && t6.normal === 1, JSON.stringify(t6));

console.log('PAGE ERRORS:', errors.length); for (const e of errors.slice(0, 10)) console.log(' ', e);
const failed = results.filter((r) => !r[1]).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL OK' : `FAILED: ${failed} checks, ${errors.length} page errors`);
await browser.close();
chrome?.kill();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
