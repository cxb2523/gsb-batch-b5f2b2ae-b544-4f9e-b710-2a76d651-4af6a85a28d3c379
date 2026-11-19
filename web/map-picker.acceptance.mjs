// Local acceptance checks for the in-browser map picker in web/index.html.
//
// It loads the real page in jsdom, injects a controllable fake `window.__xash`,
// and drives the panel exactly as a player would (open it, click a tile). No
// game server, Docker or network is needed.
//
// Run:
//   npm install                        # or: npm install --no-save jsdom
//   npm test                           # node web/map-picker.acceptance.mjs
//
// Covered cases
//   1. engine missing            -> visible failure, no switching state
//   2. engine not ready yet      -> visible failure, then works once ready
//   3. command throws            -> visible failure, panel operable again
//   4. real switch               -> completes on the engine's map change, not a clock
//   5. duplicate click           -> exactly one rcon changelevel
//   6. <body> rebuild mid-switch -> one panel, switch survives and still completes
//   7. no map change             -> timeout restores the panel with an error
//   8. re-selecting the same map -> confirmed by the engine's "Started map" log
//   9. cvar-only build           -> confirmed via getCVar('hostmap'), no log tap
//  10. search filter reset       -> cleared when the panel reopens
//  11. stale map reading         -> cannot fake success when there is no baseline
//
// Exit code 0 = every check passed.

import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// A fake engine that matches the surface the picker probes. `onCommand` may
// mutate `x.mapname`, throw, or leave things untouched.
function makeFakeXash(opts = {}) {
  const x = {
    running: opts.running !== false,
    mapname: opts.mapname || '',
    commands: [],
    failOn: opts.failOn || null, // e.g. 'changelevel'
    Cmd_ExecuteString(cmd) {
      if (x.failOn && cmd.indexOf(x.failOn) >= 0) throw new Error('fake engine rejected command');
      x.commands.push(cmd);
      if (opts.onCommand) opts.onCommand(x, cmd);
      return undefined;
    },
    // The real wrapper exposes this; make getCVar optional per scenario.
    opts: opts.withLogTap === false ? undefined : { module: {} },
  };
  if (opts.withGetCVar) {
    x.getCVar = (name) => Promise.reject(new Error('no such cvar'));
  }
  return x;
}

async function newPage(xash, extra = {}) {
  const dom = await JSDOM.fromFile(PAGE, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.__CS_MAP_SWITCH_TIMEOUT_MS = extra.timeout || 1200;
      if (xash !== undefined) window.__xash = xash;
    },
  });
  const { window } = dom;
  // Wait until the head script has injected the panel.
  for (let i = 0; i < 200 && !window.document.getElementById('cs-mapbtn'); i++) await sleep(10);
  const doc = window.document;
  const api = window.__csMapAPI;
  const tile = (name) => doc.querySelector(`#cs-mapgrid .cs-maptile[data-map="${name}"]`);
  const statusText = () => (doc.getElementById('cs-mapstatus') || {}).textContent || '';
  const statusVisible = () => {
    const el = doc.getElementById('cs-mapstatus');
    return !!el && el.style.display !== 'none' && statusText().length > 0;
  };
  const tilesDisabled = () =>
    Array.from(doc.querySelectorAll('.cs-maptile')).every((t) => t.disabled === true);
  const tilesEnabled = () =>
    Array.from(doc.querySelectorAll('.cs-maptile')).every((t) => t.disabled === false);
  const search = () => doc.getElementById('cs-mapsearch');
  const openAndClick = (name) => {
    api.open();
    tile(name).click();
  };
  return { dom, window, doc, api, tile, statusText, statusVisible, tilesDisabled, tilesEnabled, search, openAndClick };
}

// ---------------------------------------------------------------------------
section('1. engine missing -> visible failure, stays idle');
{
  const p = await newPage(undefined);
  p.api.open();
  p.tile('de_nuke').click();
  await sleep(50);
  check('status shows a failure', p.statusVisible() && /can'?t switch/i.test(p.statusText()), p.statusText());
  check('phase stays idle', p.api.state.phase === 'idle', p.api.state.phase);
  check('tiles remain enabled', p.tilesEnabled());
  check('panel remains open', p.doc.getElementById('cs-mapmenu').style.display === 'flex');
  p.window.close();
}

section('2. engine present but not ready -> failure, works once ready');
{
  const x = makeFakeXash({ running: false, mapname: 'de_dust2' });
  const p = await newPage(x);
  p.openAndClick('de_nuke');
  await sleep(50);
  check('not-ready shows a failure', p.statusVisible() && /still loading|isn'?t running/i.test(p.statusText()), p.statusText());
  check('no command issued while not ready', x.commands.length === 0, String(x.commands));
  check('phase stays idle', p.api.state.phase === 'idle');

  x.running = true;
  p.api.open();
  p.tile('de_nuke').click(); // second attempt after readiness
  check('entering switching after ready', p.api.state.phase === 'switching', p.api.state.phase);
  check('changelevel sent once', x.commands.filter((c) => c.indexOf('changelevel') >= 0).length === 1, x.commands.join(' | '));
  check('panel disabled while switching', p.tilesDisabled() && p.search().disabled === true);
  x.mapname = 'de_nuke'; // engine reports the new level
  await sleep(900);
  check('switch completes', p.api.state.phase === 'idle', p.api.state.phase);
  check('highlight follows the engine', p.api.state.selected === 'de_nuke', p.api.state.selected);
  check('panel re-enabled', p.tilesEnabled() && p.search().disabled === false);
  p.window.close();
}

section('3. command throws -> visible failure, panel operable again');
{
  const x = makeFakeXash({ mapname: 'de_dust2', failOn: 'changelevel' });
  const p = await newPage(x);
  p.openAndClick('de_nuke');
  await sleep(60);
  check('shows a failure', p.statusVisible() && /couldn'?t send/i.test(p.statusText()), p.statusText());
  check('phase idle', p.api.state.phase === 'idle', p.api.state.phase);
  check('tiles enabled again', p.tilesEnabled());
  check('search enabled again', p.search().disabled === false);
  check('highlight reverted to engine map', p.api.state.selected === 'de_dust2', p.api.state.selected);
  check('could retry immediately', (() => { p.api.state; return true; })() && p.tile('de_nuke').disabled === false);
  p.window.close();
}

section('4. success is driven by the engine map change, not a fixed wait');
{
  let fired = 0;
  const x = makeFakeXash({
    mapname: 'de_dust2',
    onCommand(engine, cmd) {
      if (cmd.indexOf('changelevel') >= 0) {
        // Level load completes quickly; then the engine reports the map.
        setTimeout(() => { engine.mapname = 'de_nuke'; }, 120);
        fired++;
      }
    },
  });
  const p = await newPage(x);
  p.search().value = 'nuke';
  p.search().dispatchEvent(new p.window.Event('input'));
  p.openAndClick('de_nuke');
  const t0 = Date.now();
  await sleep(900);
  const elapsed = Date.now() - t0;
  check('completed well before the old 4s timer', p.api.state.phase === 'idle' && elapsed < 3000, `${elapsed}ms`);
  check('success status shown', /Now playing de_nuke/i.test(p.statusText()), p.statusText());
  check('search filter reset', p.search().value === '', JSON.stringify(p.search().value));
  check('only matching tiles visible again', Array.from(p.doc.querySelectorAll('.cs-maptile')).every((t) => t.style.display !== 'none'));
  check('exactly one changelevel', x.commands.filter((c) => c.indexOf('changelevel') >= 0).length === 1);
  check('highlight on target', p.api.state.selected === 'de_nuke');
  p.window.close();
}

section('5. duplicate click while switching -> one command only');
{
  const x = makeFakeXash({ mapname: 'de_dust2' }); // never reports a new map
  const p = await newPage(x, { timeout: 1500 });
  p.openAndClick('de_nuke');
  // Bypass `disabled` to emulate a stray second submission.
  p.tile('de_aztec').onclick();
  p.tile('de_inferno').onclick();
  await sleep(100);
  check('only one changelevel sent', x.commands.filter((c) => c.indexOf('changelevel') >= 0).length === 1, x.commands.join(' | '));
  check('target unchanged by duplicates', p.api.state.target === 'de_nuke', p.api.state.target);
  check('status still reports switching', /Switching to de_nuke/i.test(p.statusText()), p.statusText());
  p.window.close();
}

section('6. <body> rebuild mid-switch keeps one panel and the in-flight switch');
{
  const x = makeFakeXash({ mapname: 'de_dust2' }); // delayed map change on purpose
  const p = await newPage(x, { timeout: 3000 });
  p.openAndClick('de_nuke');
  check('switching started', p.api.state.phase === 'switching');

  // Emulate the engine rebuilding <body>: everything we injected is gone.
  const { window, doc } = p;
  doc.body.remove();
  const fresh = doc.createElement('body');
  doc.documentElement.appendChild(fresh);
  p.api.tick(); // self-heal runs on the tick

  const menus = doc.querySelectorAll('#cs-mapmenu').length;
  const btns = doc.querySelectorAll('#cs-mapbtn').length;
  check('exactly one panel after rebuild', menus === 1, String(menus));
  check('exactly one Maps button after rebuild', btns === 1, String(btns));
  check('switch state survived', p.api.state.phase === 'switching', p.api.state.phase);
  check('panel still disabled after rebuild', p.tilesDisabled());
  check('status text restored', /Switching to de_nuke/i.test(p.statusText()), p.statusText());

  x.mapname = 'de_nuke';
  await sleep(900);
  check('switch completes after rebuild', p.api.state.phase === 'idle', p.api.state.phase);
  check('still one panel after completion', doc.querySelectorAll('#cs-mapmenu').length === 1);
  check('panel re-enabled after completion', p.tilesEnabled());
  p.window.close();
}

section('7. no engine confirmation -> timeout restores the panel with an error');
{
  const x = makeFakeXash({ mapname: 'de_dust2' }); // mapname never changes
  const p = await newPage(x, { timeout: 900 });
  p.openAndClick('de_nuke');
  check('switching started', p.api.state.phase === 'switching');
  await sleep(1500);
  check('timed out back to idle', p.api.state.phase === 'idle', p.api.state.phase);
  check('timeout error shown', p.statusVisible() && /couldn'?t confirm/i.test(p.statusText()), p.statusText());
  check('tiles enabled after timeout', p.tilesEnabled());
  check('search enabled after timeout', p.search().disabled === false);
  check('highlight reverted after timeout', p.api.state.selected === 'de_dust2', p.api.state.selected);
  p.window.close();
}

section('8. re-selecting the current map is confirmed by the engine log');
{
  const x = makeFakeXash({ mapname: 'de_nuke' });
  const p = await newPage(x, { timeout: 1500 });
  p.openAndClick('de_nuke'); // same map as the current one
  check('switching started', p.api.state.phase === 'switching');
  await sleep(120);
  check('still switching without evidence', p.api.state.phase === 'switching', p.api.state.phase);
  // The engine prints this when the level actually restarts.
  p.api.noteLog('Started map "de_nuke" (CRC "abc123")');
  await sleep(600);
  check('log line confirms the switch', p.api.state.phase === 'idle', p.api.state.phase);
  check('success status shown', /Now playing de_nuke/i.test(p.statusText()), p.statusText());
  p.window.close();
}

section('9. builds without a console tap are confirmed via getCVar');
{
  let current = 'de_dust2';
  const x = {
    running: true,
    opts: {}, // no module -> no log tap available
    Cmd_ExecuteString(cmd) {
      if (/changelevel/.test(cmd)) setTimeout(() => { current = 'de_aztec'; }, 100);
    },
    getCVar(name) {
      return name === 'hostmap' ? Promise.resolve(current) : Promise.reject(new Error('no such cvar'));
    },
  };
  const p = await newPage(x, { timeout: 3000 });
  p.api.open();
  await sleep(300); // let the open-time probe record the baseline map
  p.tile('de_aztec').click();
  await sleep(1800);
  check('completed via cvar', p.api.state.phase === 'idle', p.api.state.phase);
  check('highlight on target', p.api.state.selected === 'de_aztec', p.api.state.selected);
  check('success status shown', /Now playing de_aztec/i.test(p.statusText()), p.statusText());
  p.window.close();
}

section('10. reopening the panel clears the search filter');
{
  const x = makeFakeXash({ mapname: 'de_dust2' });
  const p = await newPage(x);
  p.api.open();
  p.search().value = 'dust';
  p.search().dispatchEvent(new p.window.Event('input'));
  const visibleWhileFiltered =
    Array.from(p.doc.querySelectorAll('.cs-maptile')).filter((t) => t.style.display !== 'none').length;
  p.api.close();
  p.api.open();
  const visibleAfterReopen =
    Array.from(p.doc.querySelectorAll('.cs-maptile')).filter((t) => t.style.display !== 'none').length;
  check('search box cleared', p.search().value === '', JSON.stringify(p.search().value));
  check('all tiles visible again', visibleAfterReopen > visibleWhileFiltered);
  p.window.close();
}

section('11. no baseline map must not be mistaken for a confirmed switch');
{
  // An engine that only exposes the map through getCVar, and whose cvar still
  // reports the *old* map that happens to be the one we clicked.
  let current = 'de_nuke';
  const x = {
    running: true,
    opts: {}, // no log tap
    Cmd_ExecuteString() {}, // accepted, but the server never changes the level
    getCVar(name) {
      return name === 'hostmap' ? Promise.resolve(current) : Promise.reject(new Error('no such cvar'));
    },
  };
  const p = await newPage(x, { timeout: 900 });
  p.openAndClick('de_nuke');
  await sleep(400);
  check('stale reading did not fake success', p.api.state.phase === 'switching', p.api.state.phase);
  await sleep(900);
  check('fell back to the timeout instead', p.api.state.phase === 'idle', p.api.state.phase);
  check('timeout error shown', /couldn'?t confirm/i.test(p.statusText()), p.statusText());
  p.window.close();
}

section('12. engine restart cycle alone confirms a re-selected map');
{
  // Only `running` is observable, and the map re-selected is the current one.
  // The client stops during the level load and comes back: that is the proof.
  const x = {
    running: true,
    opts: {},
    Cmd_ExecuteString(cmd) {
      if (/changelevel/.test(cmd)) {
        // The stop must outlast one poll (200 ms) to be observable.
        setTimeout(() => { x.running = false; }, 60);
        setTimeout(() => { x.running = true; }, 600);
      }
    },
  };
  const p = await newPage(x, { timeout: 3000 });
  p.openAndClick('de_dust2'); // no mapname/cvar at all; de_dust2 is the default pick
  await sleep(1200);
  check('restart cycle confirmed the switch', p.api.state.phase === 'idle', p.api.state.phase);
  check('success status shown', /Now playing de_dust2/i.test(p.statusText()), p.statusText());
  p.window.close();
}

section('13. client-side "Server changing, reconnecting" log confirms the switch');
{
  // Mirrors the real WebRTC client: it never sees the server's "Started map"
  // line, but it does print this while the level reloads.
  const x = {
    running: true,
    mapname: 'de_dust2', // never updates on this build
    opts: {},
    Cmd_ExecuteString(cmd) {
      if (/changelevel/.test(cmd)) {
        setTimeout(() => p.api.noteLog('Server changing, reconnecting'), 250);
      }
    },
  };
  var p;
  p = await newPage(x, { timeout: 3000 });
  p.openAndClick('de_nuke');
  await sleep(900);
  check('client reconnect notice confirmed the switch', p.api.state.phase === 'idle', p.api.state.phase);
  check('reports the requested map', /Now playing de_nuke/i.test(p.statusText()), p.statusText());
  p.window.close();
}

section('14. unrelated console text with "map:" cannot fake a map reading');
{
  const x = makeFakeXash({ mapname: 'de_dust2' });
  const p = await newPage(x, { timeout: 900 });
  p.api.open();
  p.api.noteLog('Wad files required to run the map: "%s"');
  p.api.noteLog('map_background de_dust2');
  await sleep(60);
  check('no bogus map adopted', p.api.state.selected === '', JSON.stringify(p.api.state.selected));
  p.window.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);