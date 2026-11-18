import { getRelayBase } from "./secureUrl.ts";

/** Build Xtream live MPEG-TS URL from any live stream URL variant. */
export const toXtreamTsUrl = (streamUrl: string): string | null => {
  if (/\.ts(\?|$)/i.test(streamUrl)) return streamUrl;
  if (/\.m3u8(\?|$)/i.test(streamUrl)) return streamUrl.replace(/\.m3u8(\?|$)/i, ".ts$1");
  return null;
};

/** Build Xtream live HLS URL from any live stream URL variant. */
export const toXtreamM3u8Url = (streamUrl: string): string | null => {
  if (/\.m3u8(\?|$)/i.test(streamUrl)) return streamUrl;
  if (/\.ts(\?|$)/i.test(streamUrl)) return streamUrl.replace(/\.ts(\?|$)/i, ".m3u8$1");
  return null;
};

export const buildXtreamLiveTsUrl = (
  host: string,
  username: string,
  password: string,
  streamId: string,
): string => {
  const base = host.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.ts`;
};

/** Server-side ffmpeg restream: serves browser-playable HLS remuxed from an Xtream `.ts` source. */
export const buildRestreamManifestUrl = (tsUrl: string): string =>
  `${getRelayBase()}/api/restream/index.m3u8?url=${encodeURIComponent(tsUrl)}`;

/**
 * Server-side remux for VOD in a container the engine cannot open (.mkv and
 * friends): ffmpeg stream-copies it into fragmented MP4. `startSec` seeks by
 * keyframe; the relay reports where it actually landed.
 *
 * Deliberately not routed through `toRelayUrl`: this URL already points at the
 * relay, and wrapping it would make the relay proxy itself — which its own
 * loopback blocklist correctly refuses.
 */
export const buildRemuxUrl = (sourceUrl: string, startSec = 0): string => {
  const t = startSec > 0 ? `&t=${startSec.toFixed(3)}` : "";
  return `${getRelayBase()}/api/remux?url=${encodeURIComponent(sourceUrl)}${t}`;
};

/**
 * Ask the relay to tear down a live restream now.
 *
 * ffmpeg holds a provider connection for exactly as long as it lives, and until
 * this existed nothing could end one on purpose: the relay's only teardowns
 * were a 120-second idle reaper and the implicit kill when a *different*
 * channel started. So closing the player, switching to a movie, or giving up on
 * `restream-hls` and falling back to `direct-ts` all left ffmpeg pulling the
 * provider for up to two more minutes with nobody watching — and on an account
 * with one connection slot, the next thing the user did was refused with a
 * block page.
 *
 * `tsUrl` names the source to stop; omitting it releases every live session,
 * which is what page-unload wants. Never rejects: a teardown must not be able
 * to fail because its cleanup call did.
 */
export const stopRestream = async (tsUrl?: string): Promise<void> => {
  const query = tsUrl ? `?url=${encodeURIComponent(tsUrl)}` : "";
  try {
    await fetch(`${getRelayBase()}/api/restream/stop${query}`, {
      method: "POST",
      cache: "no-store",
      // Survives the document going away, so the unload path actually lands.
      keepalive: true,
    });
  } catch {
    /* The relay may simply not be there (web build) — nothing to release. */
  }
};

export type LivePlaybackAttempt = {
  url: string;
  label: "direct-ts" | "restream-hls";
  engine: "mpegts" | "hls";
};

/**
 * Live playback attempts, in priority order:
 *   1. restream-hls - ffmpeg pulls the .ts (player headers) and remuxes to HLS,
 *      played by hls.js. This is the reliable path for providers that gate or
 *      send non-browser-decodable codecs (it normalizes to H.264/AAC).
 *   2. direct-ts - the raw .ts via the byte relay + mpegts.js (lighter, works
 *      only when the stream is already browser-decodable).
 */
export const buildLivePlaybackAttempts = (streamUrl: string): LivePlaybackAttempt[] => {
  const tsUrl = toXtreamTsUrl(streamUrl);
  if (!tsUrl) return [];
  return [
    { url: buildRestreamManifestUrl(tsUrl), label: "restream-hls", engine: "hls" },
    { url: tsUrl, label: "direct-ts", engine: "mpegts" },
  ];
};
