// Puppeteer helpers: every launch is fully isolated (own temp profile), so several
// tools / agents can run browsers at the same time.
//
// Transport selection:
//   • macOS/Linux — the historical Chrome + DevTools pipe setup, unchanged.
//   • Windows    — Chrome 136+ blocks remote debugging unless the
//                  RemoteDebuggingAllowed policy is set; the helper sets it for
//                  Chrome and Edge (idempotent), probes for a DevTools socket,
//                  and falls back Chrome → Edge (Chromium) → pipe. CHROME_PATH
//                  overrides the executable.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIN_CHROME = [
  process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);
const WIN_EDGE = [
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean);
const LINUX_CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

const chromePath = process.env.CHROME_PATH
  || (process.platform === 'darwin' && MAC_CHROME)
  || (process.platform === 'win32' && WIN_CHROME.find((p) => fs.existsSync(p)))
  || LINUX_CHROME.find((p) => fs.existsSync(p))
  || MAC_CHROME;
const edgePath = process.platform === 'win32' && WIN_EDGE.find((p) => fs.existsSync(p));

// ANGLE's Metal backend only exists on macOS; elsewhere let the browser pick D3D/GL.
const ANGLE = process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default';

/**
 * Probe whether `executable` accepts a DevTools socket in this environment.
 * Chrome 136+ refuses remote debugging with a non-default data directory unless
 * the RemoteDebuggingAllowed enterprise policy is visible to the process; some
 * sandboxes virtualise that policy tree. Windows-only: elsewhere pipe transport
 * is used directly, exactly as the original helper did.
 */
function probeSocket(executable) {
  if (process.platform !== 'win32') return false;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-probe-'));
  let pid = 0;
  try {
    // A browser that opens the DevTools port stays alive serving it, so the
    // --dump-dom invocation always hits our timeout: success is detected from
    // the "DevTools listening" line, and the whole process tree is torn down below.
    const r = spawnSync(executable, ['--remote-debugging-port=0', '--headless=new', '--no-first-run',
      `--user-data-dir=${probe}`, 'about:blank', '--dump-dom'],
      { encoding: 'utf8', timeout: 6000 });
    pid = r.pid || 0;
    return /DevTools listening on ws:\/\//.test(r.stderr || '');
  } catch {
    return false;
  } finally {
    // spawnSync's timeout SIGTERMs only the root process; kill the browser's
    // GPU/network/renderer children too, by PID tree (never by image name).
    if (pid) {
      const taskkill = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'taskkill.exe');
      try { spawnSync(taskkill, ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Chrome 136+ (and Edge 136+) only expose remote debugging when the
 * RemoteDebuggingAllowed policy is set, on machines that gate the feature.
 * Set it idempotently in both hives for both browsers before probing. Some
 * sandboxes virtualise the Google Chrome policy tree but still honour the
 * Microsoft Edge one — hence the Edge fallback below. No-op outside Windows.
 */
function ensureDebuggingPolicy() {
  if (process.platform !== 'win32') return;
  const ps = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(ps)) return;
  const roots = "'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome','HKCU:\\SOFTWARE\\Policies\\Google\\Chrome',"
    + "'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge','HKCU:\\SOFTWARE\\Policies\\Microsoft\\Edge'";
  const script = `foreach ($r in ${roots}) {`
    + ' New-Item -Path $r -Force | Out-Null;'
    + ' New-ItemProperty -Path $r -Name "RemoteDebuggingAllowed" -Value 1 -PropertyType DWord -Force | Out-Null; }';
  try { spawnSync(ps, ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 15000 }); } catch { /* non-fatal: probe decides */ }
}

let resolved = null;
/** Pick executable + transport once, caching the probe result. */
function resolveTarget() {
  if (resolved) return resolved;
  // macOS/Linux: preserve the historical pipe-on-Chrome behavior verbatim.
  if (process.platform !== 'win32') {
    resolved = { executable: chromePath, pipe: true, label: 'chrome' };
    return resolved;
  }
  // Windows: prefer a DevTools socket when the browser permits it; fall back to
  // pipe, then to Edge (Chromium) whose policy tree is readable in sandboxes that
  // virtualise Google Chrome's.
  ensureDebuggingPolicy();
  if (probeSocket(chromePath)) {
    resolved = { executable: chromePath, pipe: false, label: 'chrome' };
    return resolved;
  }
  if (edgePath && probeSocket(edgePath)) {
    resolved = { executable: edgePath, pipe: false, label: 'edge' };
    return resolved;
  }
  resolved = { executable: chromePath, pipe: true, label: 'chrome-fallback' };
  return resolved;
}

export const CHROME = chromePath;

export async function launch({ width = 1920, height = 1080 } = {}) {
  const target = resolveTarget();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-chrome-'));
  const browser = await puppeteer.launch({
    executablePath: target.executable,
    headless: true,
    pipe: target.pipe,
    userDataDir: profile,
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    args: [
      ANGLE,
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${width},${height}`,
    ],
  });
  const close = async () => {
    try { await browser.close(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  return { browser, close, transport: target.pipe ? 'pipe' : 'socket', engine: target.label };
}

// Open a page, forward console errors, and wait for window.__ready.
export async function openPage(browser, url, { timeout = 300000, verbose = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    const type = m.type();
    if (type === 'error' || verbose) {
      const text = m.text();
      if (type === 'error') errors.push(text);
      console.log(`[page ${type}] ${text}`);
    }
  });
  page.on('pageerror', (e) => {
    errors.push(String(e));
    console.log('[pageerror]', e.message);
  });
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction('window.__ready === true || !!window.__fatal', { timeout, polling: 100 });
  const fatal = await page.evaluate(() => window.__fatal || null);
  if (fatal) throw new Error('page failed to initialise: ' + fatal);
  return { page, errors };
}
