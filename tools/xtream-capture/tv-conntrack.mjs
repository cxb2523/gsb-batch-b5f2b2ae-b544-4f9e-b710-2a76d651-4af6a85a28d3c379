#!/usr/bin/env node
/**
 * Watch what a TV app's sockets actually do, from the TV itself.
 *
 * No proxy, no DNS hijack, no certificate. We read /proc/net/tcp and
 * /proc/net/tcp6 over adb, filtered to one app's uid, and turn the difference
 * between consecutive samples into connection open/close events.
 *
 * That is enough for the numbers that decide whether a provider (or a CDN in
 * front of it) starts rate-limiting you:
 *
 *   - how many connections the app opens, and how fast
 *   - how many it holds at once
 *   - how long each one lives — i.e. whether keep-alive is doing any work
 *   - which family and port it talks on, so we know whether payload capture is
 *     even possible (:80 readable, :443 not without a trusted CA)
 *
 * What it cannot see is the payload: no paths, no Range headers. This answers
 * "how does it connect", not "what does it ask for". Run it first anyway — it
 * costs one command and tells you whether the expensive route is worth taking.
 *
 * Usage:
 *   node tv-conntrack.mjs --serial 192.168.1.109:5555 --uid 10116
 *   curl "http://127.0.0.1:9912/mark?label=seek-forward"
 */

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

const SERIAL = arg("serial");
const UID = arg("uid");
const INTERVAL = arg("interval", "0.25");
const CONTROL_PORT = Number(arg("control-port", "9912"));
const OUT_DIR = arg("out", path.join(process.cwd(), "tools/xtream-capture/captures"));
const ADB = arg("adb", `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`);

if (!SERIAL || !UID) {
  console.error("usage: node tv-conntrack.mjs --serial <host:port> --uid <appUid>");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG_PATH = path.join(OUT_DIR, `conntrack-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
const log = fs.createWriteStream(LOG_PATH, { flags: "a" });
let t0 = null;
const write = (record) => log.write(`${JSON.stringify(record)}\n`);

let currentMark = "idle";
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/mark") {
    currentMark = url.searchParams.get("label") || "idle";
    write({ t: now(), ev: "mark", label: currentMark });
    console.log(`  ── ${currentMark}`);
    res.writeHead(200).end(`mark: ${currentMark}\n`);
    return;
  }
  res.writeHead(404).end();
}).listen(CONTROL_PORT, "127.0.0.1", () =>
  console.log(`control  http://127.0.0.1:${CONTROL_PORT}/mark?label=...`));

let lastUptime = 0;
const now = () => (t0 === null ? 0 : Math.round((lastUptime - t0) * 1000));

/** /proc/net/tcp stores IPv4 as a little-endian hex word. */
const hexToIpv4 = (hex) =>
  [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(".");

/** IPv6 is four little-endian 32-bit words. */
const hexToIpv6 = (hex) => {
  const words = [];
  for (let w = 0; w < 4; w += 1) {
    const le = hex.slice(w * 8, w * 8 + 8);
    const be = le.slice(6, 8) + le.slice(4, 6) + le.slice(2, 4) + le.slice(0, 2);
    words.push(be.slice(0, 4), be.slice(4, 8));
  }
  // Trim leading zeros per group, then collapse the longest zero run once.
  const trimmed = words.map((w) => w.replace(/^0+(?=.)/, ""));
  const joined = trimmed.join(":");
  const runs = joined.match(/(?:^|:)0(?::0)+(?=:|$)/g) ?? [];
  if (runs.length === 0) return joined;
  const longest = runs.reduce((a, b) => (b.length >= a.length ? b : a));
  return joined.replace(longest, "::").replace(/:{3,}/, "::");
};

const STATES = {
  "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1",
  "05": "FIN_WAIT2", "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT",
  "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING",
};

const live = new Map();   // key -> { since, peer, port, family, state }
let opened = 0;

const parseTable = (text, family) => {
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [, local, remote, st] = f;
    const uid = f[7];
    if (uid !== UID) continue;
    const [remAddr, remPort] = remote.split(":");
    if (!remPort || remPort === "0000") continue;               // listener, not a peer
    const peer = family === 4 ? hexToIpv4(remAddr) : hexToIpv6(remAddr);
    if (/^(0\.0\.0\.0|::)$/.test(peer)) continue;
    out.push({
      key: `${local}-${remote}`,
      peer,
      port: parseInt(remPort, 16),
      localPort: parseInt(local.split(":")[1], 16),
      family,
      state: STATES[st.toUpperCase()] ?? st,
    });
  }
  return out;
};

const sample = (v4, v6) => {
  const rows = [...parseTable(v4, 4), ...parseTable(v6, 6)];
  const seen = new Set();

  for (const row of rows) {
    seen.add(row.key);
    const known = live.get(row.key);
    if (!known) {
      opened += 1;
      live.set(row.key, { since: now(), ...row });
      write({ t: now(), ev: "conn-open", mark: currentMark, peer: row.peer,
              port: row.port, family: row.family, state: row.state });
    } else if (known.state !== row.state) {
      known.state = row.state;
    }
  }

  for (const [key, info] of live) {
    if (seen.has(key)) continue;
    live.delete(key);
    write({ t: now(), ev: "conn-close", mark: currentMark, peer: info.peer,
            port: info.port, family: info.family, lifeMs: now() - info.since });
  }

  write({ t: now(), ev: "sample", mark: currentMark, concurrent: rows.length, openedTotal: opened });
};

// One long-lived shell instead of one adb round-trip per sample.
const remote =
  `while true; do ` +
  `echo "==TS $(cut -d' ' -f1 /proc/uptime)"; ` +
  `echo "==V4"; cat /proc/net/tcp; ` +
  `echo "==V6"; cat /proc/net/tcp6; ` +
  `sleep ${INTERVAL}; done`;

console.log(`capture  ${LOG_PATH}`);
console.log(`watching uid ${UID} on ${SERIAL} every ${INTERVAL}s\n`);

const child = spawn(ADB, ["-s", SERIAL, "shell", remote]);
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let cut;
  // Each block runs from one ==TS to the next.
  while ((cut = buffer.indexOf("==TS", 1)) !== -1) {
    const block = buffer.slice(0, cut);
    buffer = buffer.slice(cut);
    const ts = /^==TS ([\d.]+)/.exec(block);
    if (!ts) continue;
    lastUptime = Number(ts[1]);
    if (t0 === null) t0 = lastUptime;
    const v4 = block.slice(block.indexOf("==V4") + 4, block.indexOf("==V6"));
    const v6 = block.slice(block.indexOf("==V6") + 4);
    sample(v4, v6);
  }
});

child.stderr.on("data", (c) => process.stderr.write(c));
child.on("close", (code) => { console.log(`adb shell exited (${code})`); process.exit(code ?? 0); });

const shutdown = () => { child.kill(); log.end(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
