#!/usr/bin/env node
/**
 * Xtream traffic capture — sit between a TV box and its IPTV provider and write
 * down exactly what the app asks for.
 *
 * The point is not to see the video. It is to measure the SHAPE of a working
 * client's traffic: how many connections it opens, whether it reuses them, what
 * Range headers it sends, how much of each range it actually consumes before
 * abandoning it, and what a seek really costs. That is the reference our own
 * relay has to imitate upstream, whatever the local media stack does downstream.
 *
 * Three ways to get the traffic here, in order of setup cost:
 *
 *   proxy    An HTTP forward proxy. Set the TV's Wi-Fi proxy to this machine.
 *            No root, no DNS, no certificates. Try this first — if the app
 *            ignores the system proxy you will see zero requests and know in
 *            about ten seconds.
 *
 *   dns      A DNS server that answers ONE hostname with this machine's address
 *            and forwards every other name untouched, plus reverse proxies the
 *            hijacked host to its real address. Set the TV's DNS to this
 *            machine. Works even when the app ignores proxies.
 *
 *   reverse  The reverse proxy alone, if you are pointing traffic here some
 *            other way (hosts file, router rule, your own DNS).
 *
 * NOTHING here is wired into the shipped app. It is a bench instrument.
 *
 * Safety notes:
 *  - Only the mapped host is ever intercepted. Every other DNS name is forwarded
 *    verbatim, so a device that ends up using this resolver by accident still
 *    reaches the rest of the internet normally.
 *  - Bodies are streamed, never buffered. These are multi-gigabyte videos.
 *  - Credentials are redacted on the way into the log. Xtream puts them in the
 *    query string AND in stream paths; both are handled.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { Resolver } from "node:dns/promises";

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const MODE = arg("mode", "proxy");
const HOST_TO_HIJACK = (arg("host") ?? "").toLowerCase();
const PROXY_PORT = Number(arg("proxy-port", "8888"));
const CONTROL_PORT = Number(arg("control-port", "9911"));
const DNS_PORT = Number(arg("dns-port", "53"));
// Xtream servers turn up on all of these. Listening on every one at once means
// we do not have to know the provider's port in advance — the first request
// tells us.
const LISTEN_PORTS = (arg("ports", "80,8080,8880,2082,2086,2095,25461") || "")
  .split(",").map((p) => Number(p.trim())).filter(Boolean);
const TLS_PASSTHROUGH_PORTS = (arg("tls-ports", "443,8443") || "")
  .split(",").map((p) => Number(p.trim())).filter(Boolean);
const UPSTREAM_PORT = arg("upstream-port") ? Number(arg("upstream-port")) : null;
const UPSTREAM_RESOLVER = arg("resolver", "1.1.1.1");
const OUT_DIR = arg("out", path.join(process.cwd(), "tools/xtream-capture/captures"));

if (flag("help") || (MODE !== "proxy" && !HOST_TO_HIJACK)) {
  console.log(`
xtream-capture

  --mode proxy|dns|reverse   how traffic reaches us (default: proxy)
  --host <hostname>          provider hostname to intercept (dns/reverse modes)
  --upstream-ip <ip>         real provider IP (default: resolved via ${UPSTREAM_RESOLVER})
  --proxy-port <n>           forward-proxy port (default 8888)
  --ports <a,b,c>            reverse-proxy listen ports (default ${LISTEN_PORTS.join(",")})
  --dns-port <n>             DNS listen port (default 53, needs sudo)
  --out <dir>                where capture files go
  --keep-secrets             do NOT redact credentials (avoid)

Examples
  node capture.mjs --mode proxy
  sudo node capture.mjs --mode dns --host ilvip.net
`);
  process.exit(0);
}

const REDACT = !flag("keep-secrets");

// ------------------------------------------------------------------ logging

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = path.join(OUT_DIR, `capture-${stamp}.ndjson`);
const log = fs.createWriteStream(LOG_PATH, { flags: "a" });
const started = Date.now();
const write = (record) => log.write(`${JSON.stringify({ t: Date.now() - started, ...record })}\n`);

/**
 * Xtream carries the account two ways: `?username=x&password=y` on the API, and
 * `/live/<user>/<pass>/<id>.ts` on streams. Redact both, but keep the shape so
 * the log is still readable, and keep a short stable tag so two different
 * accounts in one capture stay distinguishable.
 */
const tagFor = (() => {
  const seen = new Map();
  return (secret) => {
    if (!seen.has(secret)) seen.set(secret, `u${seen.size + 1}`);
    return seen.get(secret);
  };
})();

const redactUrl = (raw) => {
  if (!REDACT) return raw;
  let out = raw;
  out = out.replace(/([?&](?:username|password|user|pass)=)([^&]*)/gi,
    (_, k, v) => `${k}${v ? tagFor(v) : ""}`);
  // /live|movie|series/<user>/<pass>/<rest>
  out = out.replace(/^(\/(?:live|movie|series)\/)([^/]+)\/([^/]+)\//i,
    (_, head, user, pass) => `${head}${tagFor(user)}/${tagFor(pass)}/`);
  return out;
};

/**
 * ilvip.net sits behind Cloudflare, so a 429 may well be the EDGE rate-limiting
 * us rather than the provider. That makes request headers — the User-Agent above
 * all — a prime suspect for why one client sails through and another does not.
 * Record the ones a CDN actually makes decisions on.
 */
const REQUEST_HEADERS_OF_INTEREST = [
  "user-agent", "accept", "accept-encoding", "connection", "icy-metadata",
  "referer", "origin", "x-forwarded-for", "cookie",
];
const RESPONSE_HEADERS_OF_INTEREST = [
  "server", "cf-ray", "cf-cache-status", "retry-after", "x-ratelimit-remaining",
  "set-cookie", "age", "via",
];
const pick = (headers, names) => {
  const out = {};
  for (const name of names) {
    const value = headers[name];
    if (value === undefined) continue;
    // A cookie can carry a session token; keep only its shape.
    out[name] = name === "cookie" || name === "set-cookie"
      ? String(value).replace(/=[^;,]+/g, "=<v>")
      : value;
  }
  return out;
};

const classify = (pathname) => {
  const p = pathname.toLowerCase();
  if (p.includes("player_api")) return "api";
  if (p.includes("xmltv")) return "epg";
  if (p.includes("get.php")) return "playlist";
  if (p.startsWith("/live/")) return "live";
  if (p.startsWith("/movie/")) return "vod";
  if (p.startsWith("/series/")) return "series";
  if (p.endsWith(".m3u8")) return "hls-manifest";
  if (p.endsWith(".ts")) return "hls-segment";
  return "other";
};

// ------------------------------------------------------- connection identity

/**
 * The single most telling metric: how many requests ride each TCP connection.
 * A player that opens one socket and keeps it is cheap for the provider; one
 * that opens a socket per range is what trips rate limits.
 */
let connSeq = 0;
const connIdOf = (socket) => {
  if (!socket._capId) {
    socket._capId = `c${++connSeq}`;
    socket._capReqs = 0;
    socket._capOpened = Date.now() - started;
    write({ ev: "conn-open", conn: socket._capId, peer: socket.remoteAddress });
    socket.once("close", () =>
      write({
        ev: "conn-close", conn: socket._capId, requests: socket._capReqs,
        lifeMs: Date.now() - started - socket._capOpened,
      }));
  }
  return socket._capId;
};

// ------------------------------------------------------------------- marking

/** Labels pushed into the timeline while the operator performs a scripted action. */
let currentMark = "idle";

// ------------------------------------------------------------------ forward

const resolver = new Resolver();
resolver.setServers([UPSTREAM_RESOLVER]);

let upstreamIp = arg("upstream-ip", null);
const resolveUpstream = async () => {
  if (upstreamIp) return upstreamIp;
  const [first] = await resolver.resolve4(HOST_TO_HIJACK);
  upstreamIp = first;
  return upstreamIp;
};

/**
 * Pipe one request upstream and record it. `target` is where the bytes actually
 * come from; `logicalUrl` is what the client believed it was asking for.
 */
const forward = (clientReq, clientRes, target, logicalUrl) => {
  const conn = connIdOf(clientReq.socket);
  clientReq.socket._capReqs += 1;
  const reqNo = clientReq.socket._capReqs;
  const t0 = Date.now();

  const headers = { ...clientReq.headers };
  // Host must stay the provider's — virtual hosting and token checks rely on it.
  headers.host = target.hostHeader;
  delete headers["proxy-connection"];

  const agent = target.protocol === "https:" ? https : http;
  const upstream = agent.request(
    {
      protocol: target.protocol,
      host: target.address,
      port: target.port,
      method: clientReq.method,
      path: target.path,
      headers,
      servername: target.protocol === "https:" ? target.hostHeader : undefined,
      // Never follow redirects here: a 302 to a CDN node IS part of the pattern
      // we are trying to observe, and swallowing it would hide a whole hop.
    },
    (upRes) => {
      const ttfb = Date.now() - t0;
      let bytes = 0;
      upRes.on("data", (chunk) => { bytes += chunk.length; });

      const finish = (how) => {
        if (finish.done) return;
        finish.done = true;
        write({
          ev: "req", mark: currentMark, conn, reqNo,
          method: clientReq.method,
          kind: classify(target.pathnameOnly),
          url: redactUrl(logicalUrl),
          range: clientReq.headers.range ?? null,
          status: upRes.statusCode,
          location: upRes.headers.location ? redactUrl(upRes.headers.location) : null,
          contentRange: upRes.headers["content-range"] ?? null,
          contentLength: upRes.headers["content-length"] ?? null,
          contentType: upRes.headers["content-type"] ?? null,
          reqHeaders: pick(clientReq.headers, REQUEST_HEADERS_OF_INTEREST),
          resHeaders: pick(upRes.headers, RESPONSE_HEADERS_OF_INTEREST),
          ttfbMs: ttfb,
          durationMs: Date.now() - t0,
          bytes,
          // "aborted" means the player walked away mid-body — the fingerprint of
          // a seek, and of how much a client over-fetches before giving up.
          ended: how,
        });
      };

      clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(clientRes);
      upRes.on("end", () => finish("complete"));
      clientRes.on("close", () => finish(upRes.complete ? "complete" : "client-abort"));
      upRes.on("error", () => finish("upstream-error"));
    },
  );

  upstream.on("error", (error) => {
    write({
      ev: "req", mark: currentMark, conn, reqNo, method: clientReq.method,
      kind: classify(target.pathnameOnly), url: redactUrl(logicalUrl),
      range: clientReq.headers.range ?? null, status: 0,
      error: error.message, durationMs: Date.now() - t0, bytes: 0, ended: "error",
    });
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end();
  });

  clientReq.pipe(upstream);
  clientRes.on("close", () => upstream.destroy());
};

// -------------------------------------------------------------- proxy mode

const startProxy = () => {
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end("expected an absolute-URI proxy request");
      return;
    }
    forward(req, res, {
      protocol: url.protocol,
      address: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      hostHeader: url.host,
      path: url.pathname + url.search,
      pathnameOnly: url.pathname,
    }, url.pathname + url.search);
  });

  // HTTPS through a forward proxy is an opaque tunnel unless we terminate TLS.
  // We deliberately do not: a blind tunnel still reveals connection count and
  // byte volume, which is most of what we are measuring, and it keeps the
  // provider's certificate chain intact.
  server.on("connect", (req, clientSocket, head) => {
    const [host, port = "443"] = req.url.split(":");
    const conn = connIdOf(clientSocket);
    const t0 = Date.now();
    let up = 0, down = 0;
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      clientSocket.on("data", (c) => { up += c.length; });
      upstream.on("data", (c) => { down += c.length; });
      clientSocket.pipe(upstream).pipe(clientSocket);
    });
    const done = () => write({
      ev: "tunnel", mark: currentMark, conn, host, port: Number(port),
      up, down, durationMs: Date.now() - t0,
    });
    upstream.on("error", () => { clientSocket.destroy(); done(); });
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", done);
  });

  server.listen(PROXY_PORT, "0.0.0.0", () =>
    console.log(`proxy    listening on 0.0.0.0:${PROXY_PORT}`));
};

// ------------------------------------------------------------ reverse mode

const startReverse = async () => {
  const ip = await resolveUpstream();
  console.log(`upstream ${HOST_TO_HIJACK} -> ${ip}`);
  for (const port of LISTEN_PORTS) {
    const server = http.createServer((req, res) => {
      const hostHeader = (req.headers.host ?? HOST_TO_HIJACK).split(":")[0];
      const url = new URL(req.url, `http://${hostHeader}`);
      forward(req, res, {
        protocol: "http:",
        address: ip,
        // Same port upstream as the client used, unless overridden (useful when
        // the provider answers on a different port than the client dials).
        port: UPSTREAM_PORT ?? port,
        // Preserve the port the client used, or virtual hosts get confused.
        hostHeader: req.headers.host ?? HOST_TO_HIJACK,
        path: url.pathname + url.search,
        pathnameOnly: url.pathname,
      }, url.pathname + url.search);
    });
    server.on("error", (error) => console.warn(`port ${port}: ${error.message}`));
    server.listen(port, "0.0.0.0", () => console.log(`reverse  listening on 0.0.0.0:${port}`));
  }

  // Hijacking DNS points EVERY port of that hostname at us, so a port we do not
  // answer on is a dead end for the TV. TLS we cannot read without a trusted
  // certificate, so relay it byte-for-byte instead: the app keeps working, and
  // connection counts and volumes — most of what we are measuring — survive.
  for (const port of TLS_PASSTHROUGH_PORTS) {
    const relay = net.createServer((client) => {
      const conn = connIdOf(client);
      const t0 = Date.now();
      let up = 0, down = 0;
      const upstream = net.connect(port, ip, () => {
        client.on("data", (c) => { up += c.length; });
        upstream.on("data", (c) => { down += c.length; });
        client.pipe(upstream).pipe(client);
      });
      const done = () => write({
        ev: "tunnel", mark: currentMark, conn, host: HOST_TO_HIJACK, port,
        up, down, durationMs: Date.now() - t0,
      });
      upstream.on("error", () => { client.destroy(); done(); });
      client.on("error", () => upstream.destroy());
      client.on("close", done);
    });
    relay.on("error", (error) => console.warn(`tls port ${port}: ${error.message}`));
    relay.listen(port, "0.0.0.0", () => console.log(`tls-relay listening on 0.0.0.0:${port}`));
  }
};

// ---------------------------------------------------------------- dns mode

/** Minimal A-record responder: hijack one name, forward everything else. */
const startDns = (selfIp) => {
  const socket = dgram.createSocket("udp4");
  const pending = new Map();
  const upstream = dgram.createSocket("udp4");

  upstream.on("message", (msg) => {
    const id = msg.readUInt16BE(0);
    const client = pending.get(id);
    if (!client) return;
    pending.delete(id);
    socket.send(msg, client.port, client.address);
  });

  const readName = (buf, offset) => {
    const labels = [];
    let i = offset;
    while (buf[i] !== 0) {
      const len = buf[i];
      if (len > 63) break; // compression pointer — not expected in a question
      labels.push(buf.toString("ascii", i + 1, i + 1 + len));
      i += len + 1;
    }
    return { name: labels.join("."), end: i + 1 };
  };

  socket.on("message", (msg, rinfo) => {
    let question;
    try {
      question = readName(msg, 12);
    } catch {
      return;
    }
    const type = msg.readUInt16BE(question.end);
    const name = question.name.toLowerCase();
    const isTarget = name === HOST_TO_HIJACK || name.endsWith(`.${HOST_TO_HIJACK}`);
    const TYPES = { 1: "A", 2: "NS", 5: "CNAME", 12: "PTR", 16: "TXT", 28: "AAAA", 33: "SRV", 65: "HTTPS" };
    write({ ev: "dns-query", name, type: TYPES[type] ?? type, peer: rinfo.address, hijacked: isTarget && type === 1 });

    /**
     * Answer AAAA (and HTTPS/SVCB, which can carry its own address hints) for the
     * target with NOERROR-and-no-records. Left alone, the client resolves the
     * real IPv6 address, and since Android prefers IPv6 it connects straight to
     * the provider and never touches us. NODATA is the polite way to say "this
     * name is v4-only", and the client falls back to the A record we do hijack.
     */
    if (isTarget && (type === 28 || type === 65)) {
      const qLen = question.end + 4 - 12;
      const answer = Buffer.alloc(12 + qLen);
      msg.copy(answer, 0, 0, 12 + qLen);
      answer.writeUInt16BE(0x8180, 2);
      answer.writeUInt16BE(0, 6);   // no answers
      answer.writeUInt16BE(0, 8);
      answer.writeUInt16BE(0, 10);
      socket.send(answer, rinfo.port, rinfo.address);
      write({ ev: "dns", name, answered: "NODATA", type: type === 28 ? "AAAA" : "HTTPS", peer: rinfo.address });
      return;
    }

    if (isTarget && type === 1) {
      const qLen = question.end + 4 - 12;
      const answer = Buffer.alloc(12 + qLen + 16);
      msg.copy(answer, 0, 0, 12 + qLen);
      answer.writeUInt16BE(0x8180, 2); // response, recursion available
      answer.writeUInt16BE(1, 6);      // one answer
      // The query almost always carries an EDNS OPT record in ADDITIONAL, which
      // we do not copy — so its count has to be cleared, or every resolver reads
      // the reply as truncated garbage.
      answer.writeUInt16BE(0, 8);      // no authority records
      answer.writeUInt16BE(0, 10);     // no additional records
      let off = 12 + qLen;
      answer.writeUInt16BE(0xc00c, off); off += 2;   // pointer to the question name
      answer.writeUInt16BE(1, off); off += 2;        // A
      answer.writeUInt16BE(1, off); off += 2;        // IN
      answer.writeUInt32BE(5, off); off += 4;        // 5s TTL — undo is instant
      answer.writeUInt16BE(4, off); off += 2;
      for (const part of selfIp.split(".")) answer.writeUInt8(Number(part), off++);
      socket.send(answer.subarray(0, off), rinfo.port, rinfo.address);
      write({ ev: "dns", name, answered: selfIp, peer: rinfo.address });
      return;
    }

    // Anything else is none of our business — pass it through untouched so a
    // device pointed here keeps working normally.
    pending.set(msg.readUInt16BE(0), { port: rinfo.port, address: rinfo.address });
    upstream.send(msg, 53, UPSTREAM_RESOLVER);
    setTimeout(() => pending.delete(msg.readUInt16BE(0)), 5000);
  });

  socket.on("error", (error) => {
    console.error(`\nDNS could not listen on :${DNS_PORT} — ${error.message}`);
    console.error("Another copy is probably already running. Kill it first:");
    console.error("  sudo pkill -f 'capture.mjs --mode dns'\n");
    process.exit(1);
  });
  socket.bind(DNS_PORT, "0.0.0.0", () =>
    console.log(`dns      listening on 0.0.0.0:${DNS_PORT}, hijacking ${HOST_TO_HIJACK} -> ${selfIp}`));
};

// ------------------------------------------------------------ control plane

const startControl = () => {
  http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/mark") {
      currentMark = url.searchParams.get("label") || "idle";
      write({ ev: "mark", label: currentMark });
      res.writeHead(200).end(`mark: ${currentMark}\n`);
      return;
    }
    if (url.pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ log: LOG_PATH, connections: connSeq, mark: currentMark }));
      return;
    }
    res.writeHead(404).end();
  }).listen(CONTROL_PORT, "127.0.0.1", () =>
    console.log(`control  http://127.0.0.1:${CONTROL_PORT}/mark?label=...`));
};

// --------------------------------------------------------------------- main

console.log(`capture  ${LOG_PATH}`);
startControl();
if (MODE === "proxy") startProxy();
if (MODE === "reverse") await startReverse();
if (MODE === "dns") {
  const { networkInterfaces } = await import("node:os");
  const self = Object.values(networkInterfaces()).flat()
    .find((n) => n && n.family === "IPv4" && !n.internal)?.address ?? "127.0.0.1";
  await startReverse();
  startDns(self);
}
