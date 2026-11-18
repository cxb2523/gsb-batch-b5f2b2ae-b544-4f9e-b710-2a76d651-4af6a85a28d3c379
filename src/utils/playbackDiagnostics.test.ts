/**
 * Unit tests for what a failed playback attempt actually tells the user.
 *
 * The point of this module is that the reason survives all the way to the
 * screen: a provider block page's own words, the relay's own refusal text, and
 * a timeout kept distinct from a network fault. Each of those used to collapse
 * into one generic sentence and a number.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  diagnosticFailureCode,
  formatPlaybackReport,
  headlineReason,
  playbackErrorMessage,
} from "./playbackDiagnostics.ts";

describe("playbackErrorMessage", () => {
  it("keeps the stable code and puts the real reason in front", () => {
    assert.equal(
      playbackErrorMessage(12, "The provider said: maximum connections"),
      "The provider said: maximum connections (#12)",
    );
  });

  it("falls back to the generic wording when nothing is known", () => {
    assert.equal(playbackErrorMessage(9), "Something went wrong, please try again later (#9)");
    // A reason that is only whitespace must not produce a leading blank.
    assert.equal(
      playbackErrorMessage(9, "   "),
      "Something went wrong, please try again later (#9)",
    );
  });
});

describe("diagnosticFailureCode", () => {
  it("names the block pages worth telling apart", () => {
    assert.equal(
      diagnosticFailureCode(
        { payloadKind: "html", bodyPreviewText: "XUI.one debug mode is enabled" },
        "hls",
      ),
      1,
    );
    assert.equal(
      diagnosticFailureCode(
        { payloadKind: "html", bodyPreviewText: "Just a moment... Cloudflare" },
        "hls",
      ),
      2,
    );
    assert.equal(
      diagnosticFailureCode({ payloadKind: "html", bodyPreviewText: "Token expired" }, "hls"),
      3,
    );
  });

  it("treats a relay refusal as #12 rather than a payload-shape guess", () => {
    // Without the httpStatus rule this scored #5 — an .m3u8 that "did not
    // return a manifest", which is technically true and useless when the relay
    // had already written down exactly why it refused.
    assert.equal(
      diagnosticFailureCode(
        {
          probeFetch: "ok",
          httpStatus: 502,
          urlExtension: "m3u8",
          payloadKind: "unknown",
          bodyPreviewText: "The provider answered with a web page instead of video",
        },
        "hls",
      ),
      12,
    );
  });

  it("separates a timed-out probe from a network failure", () => {
    assert.equal(diagnosticFailureCode({ probeFetch: "timeout" }, "native"), 11);
    assert.equal(diagnosticFailureCode({ probeFetch: "failed" }, "native"), 7);
  });

  it("leaves the pre-existing mapping alone", () => {
    assert.equal(diagnosticFailureCode({ urlExtension: "m3u8", payloadKind: "mpegts" }, "hls"), 4);
    assert.equal(
      diagnosticFailureCode({ urlExtension: "m3u8", payloadKind: "unknown", probeFetch: "ok" }, "hls"),
      5,
    );
    assert.equal(
      diagnosticFailureCode({ urlExtension: "ts", payloadKind: "hls-manifest" }, "mpegts"),
      6,
    );
    assert.equal(diagnosticFailureCode({ probeFetch: "ok", payloadKind: "mpegts" }, "hls"), 8);
    assert.equal(diagnosticFailureCode({ probeFetch: "ok", payloadKind: "hls-manifest" }, "hls"), null);
  });
});

describe("headlineReason", () => {
  it("quotes the relay's own refusal, adding its status", () => {
    assert.equal(
      headlineReason({
        httpStatus: 502,
        bodyPreviewText: "The provider answered with a web page. It said: Maximum connections reached",
      }),
      "The provider answered with a web page. It said: Maximum connections reached (HTTP 502)",
    );
  });

  it("does not stack a second status onto a message that already names one", () => {
    // The relay reports the PROVIDER's status inside its own 502 body; showing
    // both reads as two contradictory codes for a single failure.
    assert.equal(
      headlineReason({
        httpStatus: 502,
        bodyPreviewText: "The provider answered with a web page instead of video (HTTP 404). It said: Token expired",
      }),
      "The provider answered with a web page instead of video (HTTP 404). It said: Token expired",
    );
  });

  it("still says something when a refusal has no readable body", () => {
    assert.equal(
      headlineReason({ httpStatus: 403, bodyPreviewText: "(non-text or empty)" }),
      "The stream server answered HTTP 403",
    );
  });

  it("quotes a 200-with-HTML block page directly, whitespace collapsed", () => {
    assert.equal(
      headlineReason({
        httpStatus: 200,
        payloadKind: "html",
        bodyPreviewText: "Your   token\nhas expired",
      }),
      "The provider answered with a web page: “Your token has expired”",
    );
  });

  it("distinguishes a timeout from a transport error", () => {
    assert.equal(
      headlineReason({ probeFetch: "timeout" }),
      "The stream did not start responding in time",
    );
    assert.equal(
      headlineReason({ probeFetch: "failed", fetchError: "TypeError: Load failed" }),
      "TypeError: Load failed",
    );
  });

  it("has nothing to say about a healthy probe", () => {
    assert.equal(headlineReason({ probeFetch: "ok", payloadKind: "mpegts" }), null);
  });

  it("truncates a page that dumps its whole body at us", () => {
    const reason = headlineReason({
      httpStatus: 200,
      payloadKind: "html",
      bodyPreviewText: "x".repeat(500),
    });
    assert.ok(reason && reason.length < 220, reason ?? "(null)");
    assert.ok(reason?.includes("…"));
  });
});

describe("formatPlaybackReport", () => {
  it("redacts path-style and query-style Xtream credentials", () => {
    const text = formatPlaybackReport({
      reason: "startup-timeout",
      streamUrl: "http://panel.example:8080/movie/joe/hunter2/551.mkv",
      streamProbe: {
        playbackUrl:
          "http://127.0.0.1:11471/api/stream?url=http%3A%2F%2Fpanel.example%2Fplayer_api.php%3Fusername%3Djoe%26password%3Dhunter2",
        bodyPreviewText: "Maximum connections reached",
      },
    });
    assert.ok(!text.includes("hunter2"), text);
    assert.ok(!text.includes("joe"), text);
    // The parts that make the report worth reading survive.
    assert.ok(text.includes("startup-timeout"));
    assert.ok(text.includes("Maximum connections reached"));
    assert.ok(text.includes("panel.example"));
  });

  it("redacts every URL-shaped value, not just a list of known field names", () => {
    // probeUrl and currentSrc both wrap the provider URL inside ?url=, and both
    // were missed by the key-allowlist this replaced.
    const text = formatPlaybackReport({
      currentSrc:
        "http://127.0.0.1:11471/api/stream?url=http%3A%2F%2Fpanel.example%2Fmovie%2Fjoe%2Fhunter2%2F551.mp4",
      streamProbe: {
        probeUrl:
          "http://127.0.0.1:11471/api/stream?url=http%3A%2F%2Fpanel.example%2Flive%2Fjoe%2Fhunter2%2F9.ts",
      },
      attemptsTried: ["restream-hls", "direct-ts"],
    });
    assert.ok(!text.includes("hunter2"), text);
    assert.ok(!text.includes("joe"), text);
    // Plain labels must survive the sweep untouched.
    assert.ok(text.includes("restream-hls"));
    assert.ok(text.includes("direct-ts"));
  });

  it("leaves non-URL text alone even when it looks path-ish", () => {
    const text = formatPlaybackReport({ reason: "/movie/one/two/three" });
    assert.ok(text.includes("/movie/one/two/three"), text);
  });
});
