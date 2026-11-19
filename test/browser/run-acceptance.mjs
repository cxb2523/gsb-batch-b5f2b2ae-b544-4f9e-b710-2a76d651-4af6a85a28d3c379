// Real-browser acceptance driver.
//
// Serves the repo root over HTTP, launches the installed Chrome/Edge headless
// with the DevTools protocol, loads test/browser/acceptance.html (which drives
// the real noise.js component against the real Tone.js Web Audio graph) and
// polls Runtime.evaluate for the page's verdict.
//
// Run with: node test/browser/run-acceptance.mjs
import { createServer } from 'node:http'
import { readFile, stat, rm } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const port = Number(process.env.ACCEPTANCE_PORT || 4319)
const devtoolsPort = Number(process.env.ACCEPTANCE_DEVTOOLS_PORT || 4320)

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const filePath = normalize(join(repoRoot, urlPath === '/' ? 'test/browser/acceptance.html' : urlPath))
    if (!filePath.startsWith(repoRoot)) {
      res.writeHead(403).end('forbidden')
      return
    }
    await stat(filePath)
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

await new Promise(resolve => server.listen(port, resolve))

const candidates = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean)

let browserPath = null
for (const candidate of candidates) {
  try {
    await stat(candidate)
    browserPath = candidate
    break
  } catch { /* try next */ }
}
if (!browserPath) {
  console.error('No Chrome/Edge binary found; set CHROME_BIN.')
  process.exit(2)
}

// Chrome/Edge 157 refuses to open a debugging port when the profile directory
// resolves under certain redirected app-data paths; use the OS temp directory
// (which points at the writable redirected TEMP in this environment).
const userDataDir = join(tmpdir(), 'noisedash-acceptance-chrome')
await rm(userDataDir, { recursive: true, force: true })
const child = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${devtoolsPort}`,
  `--user-data-dir=${userDataDir}`,
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--allow-file-access-from-files',
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })

let devtoolsUrl = null
child.stderr.on('data', () => { /* endpoint discovered via HTTP below */ })
child.on('exit', code => {
  if (!devtoolsUrl) {
    process.exit(code ?? 2)
  }
})

// Discover the browser-level DevTools endpoint, then create an explicit page
// target and attach to its page-level session (Page/Runtime domains live there).
for (let i = 0; i < 60 && !devtoolsUrl; i++) {
  try {
    const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)
    if (response.ok) {
      const info = await response.json()
      devtoolsUrl = info.webSocketDebuggerUrl
    }
  } catch {
    await delay(100)
  }
}
if (!devtoolsUrl) {
  console.error('Timed out waiting for DevTools HTTP endpoint.')
  child.kill()
  process.exit(2)
}

// Open a WebSocket to the browser endpoint, create a fresh page target and
// reconnect to that target's page-level WebSocket (Page/Runtime domains).
const browserWs = new WebSocket(devtoolsUrl)
await new Promise((resolve, reject) => {
  browserWs.addEventListener('open', resolve, { once: true })
  browserWs.addEventListener('error', reject, { once: true })
})

let browserMessageId = 0
const browserPending = new Map()
browserWs.addEventListener('message', event => {
  const msg = JSON.parse(event.data)
  if (msg.id && browserPending.has(msg.id)) {
    const { resolve, reject } = browserPending.get(msg.id)
    browserPending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
})

function sendToBrowser (method, params = {}) {
  const id = ++browserMessageId
  return new Promise((resolve, reject) => {
    browserPending.set(id, { resolve, reject })
    browserWs.send(JSON.stringify({ id, method, params }))
  })
}

const { targetId } = await sendToBrowser('Target.createTarget', { url: 'about:blank' })
const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json()
const pageTarget = targets.find(t => t.id === targetId)
if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
  console.error('Could not resolve page target WebSocket URL.')
  child.kill()
  process.exit(2)
}

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let messageId = 0
const pending = new Map()
const pageLog = []
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.consoleAPICalled') {
    pageLog.push(msg.params.args.map(a => a.value || a.description || '').join(' '))
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const details = msg.params.exceptionDetails
    pageLog.push('EXCEPTION: ' + (details.exception ? details.exception.description : details.text) +
      (details.url ? ' @ ' + details.url + ':' + details.lineNumber + ':' + details.columnNumber : ''))
  } else if (msg.method === 'Log.entryAdded') {
    pageLog.push('LOG: ' + msg.params.entry.text + ' [' + (msg.params.entry.url || '') + ']')
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
})

function send (method, params = {}) {
  const id = ++messageId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function evaluate (expression) {
  return send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }).then(r => r.result.value)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  const pageUrl = `http://127.0.0.1:${port}/test/browser/acceptance.html`
  await send('Page.navigate', { url: pageUrl })

  let result = null
  for (let i = 0; i < 200; i++) {
    await delay(250)
    result = await evaluate('window.__acceptanceResult || null')
    if (result && (result.pass !== undefined || result.fatal)) {
      break
    }
  }

  if (!result) {
    console.error('Timed out waiting for acceptance result. Page output:')
    console.error(pageLog.join('\n') || '(no console output captured)')
    process.exitCode = 1
  } else if (result.fatal) {
    console.error('Page crashed during acceptance run:\n', result.fatal)
    process.exitCode = 1
  } else {
    for (const r of result.results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
    }
    console.log('\nPeak simultaneous live nodes per kind:', JSON.stringify(result.peakCounts))
    console.log('Final live nodes per kind:', JSON.stringify(result.liveCounts))
    console.log(result.pass ? '\nALL BROWSER ACCEPTANCE CHECKS PASSED' : '\nBROWSER ACCEPTANCE FAILURES')
    process.exitCode = result.pass ? 0 : 1
  }
} finally {
  ws.close()
  browserWs.close()
  child.kill()
  server.close()
}
