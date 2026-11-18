#!/usr/bin/env node
/**
 * Turn a capture into the four numbers that actually decide whether a client
 * annoys an IPTV provider:
 *
 *   requests/min          how chatty it is
 *   connections/min       how often it makes the provider accept a new socket —
 *                         the usual trigger for per-IP rate limiting
 *   requests per socket   the inverse: is keep-alive being used at all
 *   wasted bytes          bytes fetched and then abandoned mid-body, i.e. how
 *                         much a seek over-fetches
 *
 * Everything is broken down by the marks pushed during the session, so
 * "steady playback" and "seek forward 10 min" can be compared directly — both
 * within one client and between two different clients.
 */

import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node report.mjs <capture.ndjson> [--csv]");
  process.exit(1);
}

const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const queries = rows.filter((r) => r.ev === "dns-query" && r.peer !== "127.0.0.1");
const requests = rows.filter((r) => r.ev === "req");
const opens = rows.filter((r) => r.ev === "conn-open");
const closes = rows.filter((r) => r.ev === "conn-close");
const tunnels = rows.filter((r) => r.ev === "tunnel");

if (queries.length) {
  const byPeer = new Map();
  for (const q of queries) byPeer.set(q.peer, (byPeer.get(q.peer) ?? 0) + 1);
  console.log("\nDNS queries reaching us (excluding this machine)");
  for (const [peer, n] of byPeer) console.log(`  ${peer}  ${n} queries`);
  const names = [...new Set(queries.map((q) => q.name))];
  console.log(`  ${names.length} distinct names; hijacked ${queries.filter((q) => q.hijacked).length}`);
  console.log(`  sample: ${names.slice(0, 12).join(", ")}`);
}

if (requests.length === 0 && tunnels.length === 0) {
  console.log("No traffic captured. The client never reached this machine —");
  console.log("in proxy mode that usually means the app ignores the system proxy.");
  process.exit(0);
}

const spanMin = (list) => {
  if (list.length === 0) return 0;
  const t = list.map((r) => r.t);
  return (Math.max(...t) - Math.min(...t)) / 60000;
};

/**
 * A rate over a two-second phase is noise dressed up as a measurement. Only
 * report one once the phase is long enough for it to mean something.
 */
const MIN_RATE_SPAN_MIN = 10 / 60;
const rate = (count, mins) => (mins < MIN_RATE_SPAN_MIN ? "-" : +(count / mins).toFixed(1));

const fmtBytes = (n) => {
  const units = ["B", "KB", "MB", "GB"];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};

// ---- per-mark breakdown ---------------------------------------------------

const marks = [...new Set(requests.map((r) => r.mark ?? "idle"))];
const perMark = marks.map((mark) => {
  const slice = requests.filter((r) => (r.mark ?? "idle") === mark);
  const mins = spanMin(slice);
  const conns = new Set(slice.map((r) => r.conn));
  const aborted = slice.filter((r) => r.ended === "client-abort");
  const ranged = slice.filter((r) => r.range);
  return {
    mark,
    requests: slice.length,
    reqPerMin: rate(slice.length, mins),
    sockets: conns.size,
    reqPerSocket: +(slice.length / Math.max(1, conns.size)).toFixed(1),
    ranged: ranged.length,
    aborted: aborted.length,
    bytes: slice.reduce((a, r) => a + (r.bytes ?? 0), 0),
    wasted: aborted.reduce((a, r) => a + (r.bytes ?? 0), 0),
    redirects: slice.filter((r) => r.status >= 300 && r.status < 400).length,
    errors: slice.filter((r) => r.status === 0 || r.status >= 400).length,
    medianTtfb: median(slice.map((r) => r.ttfbMs).filter(Number.isFinite)),
  };
});

function median(list) {
  if (list.length === 0) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---- output ---------------------------------------------------------------

const pad = (v, w) => String(v).padEnd(w);
const padL = (v, w) => String(v).padStart(w);

console.log(`\n${file}`);
console.log(`${requests.length} requests, ${opens.length} connections, ${tunnels.length} TLS tunnels, over ${spanMin(rows).toFixed(1)} min\n`);

console.log(pad("phase", 26) + padL("reqs", 6) + padL("req/min", 9) + padL("socks", 7) +
            padL("req/sock", 9) + padL("ranged", 8) + padL("aborted", 9) + padL("bytes", 10) + padL("wasted", 10));
console.log("-".repeat(94));
for (const m of perMark) {
  console.log(
    pad(m.mark.slice(0, 25), 26) + padL(m.requests, 6) + padL(m.reqPerMin, 9) +
    padL(m.sockets, 7) + padL(m.reqPerSocket, 9) + padL(m.ranged, 8) +
    padL(m.aborted, 9) + padL(fmtBytes(m.bytes), 10) + padL(fmtBytes(m.wasted), 10));
}

const totalConnMin = spanMin(opens);
console.log("\nconnections/min overall:", rate(opens.length, totalConnMin));
const reuse = closes.filter((c) => c.requests > 1).length;
console.log(`sockets carrying >1 request: ${reuse}/${closes.length}` +
  (closes.length ? ` (${Math.round((reuse / closes.length) * 100)}%)` : ""));

// ---- request-kind mix -----------------------------------------------------

console.log("\nby kind");
const kinds = [...new Set(requests.map((r) => r.kind))];
for (const kind of kinds.sort()) {
  const slice = requests.filter((r) => r.kind === kind);
  console.log(`  ${pad(kind, 14)}${padL(slice.length, 5)}  ${fmtBytes(slice.reduce((a, r) => a + (r.bytes ?? 0), 0))}`);
}

// ---- the seek fingerprint -------------------------------------------------

const seekish = requests.filter((r) => /seek|forward|skip|jump/i.test(r.mark ?? ""));
if (seekish.length) {
  console.log("\nseek fingerprint");
  for (const r of seekish.slice(0, 40)) {
    console.log(`  +${String(r.t).padStart(7)}ms ${pad(r.mark.slice(0, 18), 19)}${pad(r.kind, 10)}` +
      `${padL(r.status, 4)}  range=${pad(r.range ?? "-", 26)} got=${padL(fmtBytes(r.bytes ?? 0), 9)} ${r.ended}`);
  }
  if (seekish.length > 40) console.log(`  ... and ${seekish.length - 40} more`);
}

// ---- how this client introduces itself ------------------------------------

const agents = new Map();
for (const r of requests) {
  const ua = r.reqHeaders?.["user-agent"] ?? "(none)";
  agents.set(ua, (agents.get(ua) ?? 0) + 1);
}
if (agents.size) {
  console.log("\nUser-Agent seen");
  for (const [ua, n] of [...agents].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${padL(n, 5)}  ${ua}`);
  }
}

const throttled = requests.filter((r) => r.status === 429 || r.resHeaders?.["retry-after"]);
if (throttled.length) {
  console.log(`\n${throttled.length} throttled responses`);
  for (const r of throttled.slice(0, 10)) {
    console.log(`  +${String(r.t).padStart(7)}ms ${pad(r.kind, 10)}${padL(r.status, 4)}` +
      `  retry-after=${r.resHeaders?.["retry-after"] ?? "-"}  server=${r.resHeaders?.server ?? "-"}`);
  }
}

const edge = requests.find((r) => r.resHeaders?.["cf-ray"]);
if (edge) console.log("\nUpstream is behind Cloudflare (cf-ray present) — 429s may be the edge, not the provider.");

// ---- what the API said about the account ----------------------------------

const api = requests.filter((r) => r.kind === "api");
if (api.length) {
  console.log(`\n${api.length} player_api calls — check the first user_info response for max_connections.`);
}
