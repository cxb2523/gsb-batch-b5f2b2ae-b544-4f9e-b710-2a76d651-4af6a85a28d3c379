/**
 * Turning a failed playback attempt into something a person can act on.
 *
 * Split out of VideoPlayer.tsx so the part that decides WHAT the user is told
 * is pure, and therefore testable — the component around it is not. Everything
 * here takes the diagnostic object built by `diagnoseStreamUrl` and returns
 * text; nothing here touches the DOM or the network.
 */

import { redactUrl } from "./redactUrl.ts";

export type PlaybackMode = "hls" | "mpegts" | "native" | "remux";

// User-facing playback errors carry a stable numeric code, and — when we know
// it — the actual reason in front of it.
//
// They used to be generic on purpose, with the detail going only to
// `console.error`. That is unreachable in the packaged app: a code alone left
// the one genuinely diagnostic thing (the provider's own words on its block
// page — "maximum connections", "token expired") invisible to the person who
// needed it. The full JSON report is now also attached to the error box, so a
// failure can be read where it happens instead of guessed at from a number.
export const GENERIC_PLAYBACK_MESSAGE = "Something went wrong, please try again later";
export const playbackErrorMessage = (code: number, reason?: string | null): string => {
  const head = reason?.trim();
  return head ? `${head} (#${code})` : `${GENERIC_PLAYBACK_MESSAGE} (#${code})`;
};

/**
 * Map a stream diagnostic to a stable error code. The mapping (not the wording)
 * is what identifies the failure:
 *   1 XUI.one debug page · 2 Cloudflare challenge · 3 other HTML page ·
 *   4 .m3u8 URL serving MPEG-TS · 5 .m3u8 URL not returning a manifest ·
 *   6 .ts URL returning a manifest · 7 fetch/CORS failure · 8 non-HLS payload ·
 *   10 video track present but no frames rendered (WKWebView layer stall) ·
 *   11 the probe timed out · 12 the relay itself refused (4xx/5xx).
 *
 * 11 and 12 were carved out of 7, which had grown to mean three unrelated
 * things at once. A probe that times out is usually the relay deliberately
 * HOLDING the request through a provider cool-down (see RATE_LIMIT_TOTAL_STALL
 * in relay.rs) — the opposite diagnosis from "the network is unreachable", and
 * reporting both as "fetch/CORS failure" sent every investigation the wrong way.
 */
export const diagnosticFailureCode = (
  diagnostic: Record<string, unknown>,
  playbackMode: PlaybackMode,
): number | null => {
  const preview = String(diagnostic.bodyPreviewText ?? "").toLowerCase();
  const payloadKind = diagnostic.payloadKind;
  const urlExtension = String(diagnostic.urlExtension ?? "");
  const httpStatus = Number(diagnostic.httpStatus ?? 0);

  if (preview.includes("xui.one") && preview.includes("debug mode")) return 1;
  if (payloadKind === "html") {
    return preview.includes("cloudflare") || preview.includes("just a moment") ? 2 : 3;
  }
  // The relay answered, and answered with a refusal. Its body is a sentence
  // written for this exact situation, so it outranks any payload-shape guess.
  if (httpStatus >= 400) return 12;
  if (urlExtension === "m3u8" && payloadKind === "mpegts") return 4;
  if (urlExtension === "m3u8" && payloadKind !== "hls-manifest" && diagnostic.probeFetch === "ok") return 5;
  if (urlExtension === "ts" && payloadKind === "hls-manifest") return 6;
  if (diagnostic.probeFetch === "timeout") return 11;
  if (diagnostic.probeFetch === "failed") return 7;
  if (playbackMode === "hls" && payloadKind !== "hls-manifest" && payloadKind !== "unknown") return 8;
  return null;
};

/**
 * The one sentence worth putting in front of the user, pulled from whatever the
 * probe actually learned.
 *
 * Order matters: the relay's own refusal text is written for this exact
 * situation ("the provider said: …"), a provider block page is the provider
 * speaking for itself, and only if neither exists do we fall back to the
 * transport-level error. Anything longer than a sentence is detail, not a
 * headline — that lives in the report attached below the message.
 */
export const HEADLINE_REASON_MAX = 160;

export const headlineReason = (diagnostic: Record<string, unknown>): string | null => {
  const oneLine = (value: unknown): string | null => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text || text === "(non-text or empty)" || text === "(empty)") return null;
    return text.length > HEADLINE_REASON_MAX ? `${text.slice(0, HEADLINE_REASON_MAX)}…` : text;
  };

  const status = Number(diagnostic.httpStatus ?? 0);
  // 4xx/5xx from our own relay: the body IS the explanation it wrote for us.
  if (status >= 400) {
    const body = oneLine(diagnostic.bodyPreviewText);
    if (!body) return `The stream server answered HTTP ${status}`;
    // The relay quotes the provider's own status in its text. Appending ours on
    // top reads as two contradictory codes for one failure, so only add it when
    // the message names no status at all.
    return /\bHTTP \d{3}\b/.test(body) ? body : `${body} (HTTP ${status})`;
  }
  // A provider block page served with a 200 — its text is the whole story.
  if (diagnostic.payloadKind === "html") {
    const body = oneLine(diagnostic.bodyPreviewText);
    return body ? `The provider answered with a web page: “${body}”` : null;
  }
  if (diagnostic.probeFetch === "timeout") {
    return "The stream did not start responding in time";
  }
  if (diagnostic.probeFetch === "failed") {
    return oneLine(diagnostic.fetchError) ?? oneLine(diagnostic.likelyCause);
  }
  return null;
};

/**
 * The same report, safe to show on screen and to copy.
 *
 * Xtream credentials live in the stream URL itself, so every URL-shaped VALUE
 * goes through `redactUrl` — deliberately keyed on what the string looks like
 * rather than on a list of field names. The allowlist version of this missed
 * `probeUrl` and `currentSrc`, both of which carry the provider URL verbatim
 * inside `?url=`; a report meant to be pasted into a support thread must not
 * hand over a subscription with it, and the next field added must be safe by
 * default rather than safe only if someone remembers to list it.
 */
const looksLikeUrl = (value: string): boolean =>
  /^https?:\/\//i.test(value) || value.startsWith("/api/");

export const redactReport = (value: unknown): unknown => {
  if (typeof value === "string") return looksLikeUrl(value) ? redactUrl(value) : value;
  if (Array.isArray(value)) return value.map((entry) => redactReport(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactReport(v)]),
    );
  }
  return value;
};

export const formatPlaybackReport = (report: Record<string, unknown>): string =>
  JSON.stringify(redactReport(report), null, 2);
