# xtream-capture

A bench instrument for watching how a *working* IPTV client talks to the
provider, so our relay can imitate its upstream behaviour.

Nothing here ships. It is not imported by the app and not part of any build.

## What it measures

Not the video — the **shape** of the traffic:

| metric | why it matters |
|---|---|
| connections opened per minute | the usual trigger for per-IP rate limiting |
| requests per socket | is keep-alive being used, or is every range a new socket |
| Range headers, and bytes actually consumed | how much a seek over-fetches before being abandoned |
| User-Agent and friends | `ilvip.net` is behind Cloudflare; the edge makes decisions on these |
| 429s and `Retry-After` | whether throttling comes from the edge (`cf-ray`) or the origin |

## Getting the traffic here

Only ever configure the **test** TV. Never the router — that would drag every
device in the house through this machine.

### 1. Proxy (try this first — 30 seconds, no root, no certificates)

```bash
node tools/xtream-capture/capture.mjs --mode proxy
```

On the test TV: Settings → Network → the current network → Advanced → **Proxy:
Manual**, host = this machine's LAN IP, port = `8888`.

If the app honours the system proxy you get full request detail for HTTP. If it
does not, you will see *zero* requests within seconds and know to switch.

### 2. DNS (works even when the app ignores proxies)

```bash
sudo node tools/xtream-capture/capture.mjs --mode dns --host ilvip.net
```

`sudo` is only for binding ports 53 and 80. It answers that one hostname with
this machine's address, forwards every other name untouched, reverse-proxies the
common Xtream HTTP ports, and byte-relays TLS ports so the app keeps working even
where we cannot read the payload.

On the test TV: Settings → Network → the current network → Advanced → IP settings
→ **Static**, and set DNS 1 to this machine's LAN IP. Keep the same IP/gateway/
prefix the TV already had.

The hijack answer carries a **5 second TTL**, so stopping the tool restores normal
resolution almost immediately.

### 3. Reverse only

If you are pointing traffic here some other way (hosts file, router rule):

```bash
sudo node tools/xtream-capture/capture.mjs --mode reverse --host ilvip.net
```

## Running a session

Label the timeline as you go, so phases can be compared:

```bash
curl "http://127.0.0.1:9911/mark?label=steady-playback"
curl "http://127.0.0.1:9911/mark?label=seek-forward-10min"
```

Then read it:

```bash
node tools/xtream-capture/report.mjs tools/xtream-capture/captures/capture-*.ndjson
```

## Credentials

Xtream carries the account in the query string *and* in stream paths, and
sessions in cookies. All three are redacted on the way into the log, replaced by
stable tags (`u1`, `u2`) so two accounts in one capture stay distinguishable.
Verify before sharing a capture:

```bash
grep -c "<your username>" tools/xtream-capture/captures/*.ndjson   # must be 0
```

`--keep-secrets` disables redaction. Do not use it.

## Limits

- **HTTPS is opaque.** Through the proxy an HTTPS request is a CONNECT tunnel;
  through DNS it is a byte relay. Either way you get connection counts and
  volumes but not paths or ranges. Reading those needs a CA the TV trusts, which
  a retail Google TV will not accept — that is the case for an emulator with a
  rootable (non-Play) Android TV image.
- Redirects are **not** followed. A 302 to a CDN node is part of the pattern
  worth seeing, so it is passed to the client intact.
