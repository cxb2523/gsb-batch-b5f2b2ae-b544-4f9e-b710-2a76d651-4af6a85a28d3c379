/**
 * Unit tests for the live-playback URL builders and the restream stop call.
 *
 * `stopRestream` is the only thing that can end a relay-side ffmpeg on purpose,
 * and an ffmpeg holds a provider connection for as long as it lives. Its two
 * contracts — target the right session, and never throw into a teardown — are
 * what these cover.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setRelayBase } from "./secureUrl.ts";
import {
  buildLivePlaybackAttempts,
  stopRestream,
  toXtreamM3u8Url,
  toXtreamTsUrl,
} from "./xtreamStreamUrl.ts";

const TS = "http://panel.example:8080/live/joe/hunter2/9.ts";

interface Call {
  url: string;
  method?: string;
  keepalive?: boolean;
}

/** Swap in a recording fetch; returns the calls it captured. */
const recordFetch = (impl?: () => Promise<unknown>): Call[] => {
  const calls: Call[] = [];
  (globalThis as { fetch?: unknown }).fetch = (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, keepalive: init?.keepalive });
    return impl ? impl() : Promise.resolve({ ok: true });
  };
  return calls;
};

afterEach(() => {
  setRelayBase("");
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe("toXtreamTsUrl / toXtreamM3u8Url", () => {
  it("converts between the two Xtream live forms", () => {
    assert.equal(toXtreamTsUrl(TS), TS);
    assert.equal(toXtreamM3u8Url(TS), "http://panel.example:8080/live/joe/hunter2/9.m3u8");
    assert.equal(toXtreamTsUrl("http://p/live/u/p/9.m3u8"), "http://p/live/u/p/9.ts");
  });

  it("refuses a URL that is neither", () => {
    assert.equal(toXtreamTsUrl("http://panel.example/movie/u/p/551.mp4"), null);
  });
});

describe("buildLivePlaybackAttempts", () => {
  it("puts the ffmpeg restream first and the raw .ts second", () => {
    setRelayBase("http://127.0.0.1:11471");
    const attempts = buildLivePlaybackAttempts(TS);
    assert.deepEqual(
      attempts.map((a) => a.label),
      ["restream-hls", "direct-ts"],
    );
    assert.ok(attempts[0].url.startsWith("http://127.0.0.1:11471/api/restream/index.m3u8?url="));
    assert.equal(attempts[1].url, TS);
  });
});

describe("stopRestream", () => {
  it("targets one session by its source URL", async () => {
    setRelayBase("http://127.0.0.1:11471");
    const calls = recordFetch();
    await stopRestream(TS);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `http://127.0.0.1:11471/api/restream/stop?url=${encodeURIComponent(TS)}`,
    );
    assert.equal(calls[0].method, "POST");
    // Unload is a real caller; the request has to outlive the document.
    assert.equal(calls[0].keepalive, true);
  });

  it("releases every session when given no URL", async () => {
    setRelayBase("http://127.0.0.1:11471");
    const calls = recordFetch();
    await stopRestream();
    assert.equal(calls[0].url, "http://127.0.0.1:11471/api/restream/stop");
  });

  it("never throws into the teardown that called it", async () => {
    // The web build has no relay at all, so this rejects routinely — and it is
    // always called from a cleanup path that must still finish.
    const calls = recordFetch(() => Promise.reject(new Error("Failed to fetch")));
    await assert.doesNotReject(() => stopRestream(TS));
    assert.equal(calls.length, 1);
  });
});
