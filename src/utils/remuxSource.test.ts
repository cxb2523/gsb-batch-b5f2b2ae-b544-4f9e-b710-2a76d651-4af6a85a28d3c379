import test from "node:test";
import assert from "node:assert/strict";
import { audioObjectType, codecStringFromInit } from "./remuxSource.ts";

const bytes = (hex: string): Uint8Array =>
  new Uint8Array(hex.trim().split(/\s+/).map((b) => parseInt(b, 16)));

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * The esds exactly as ffmpeg wrote it for a real provider episode (H.264 +
 * AAC-LC Matroska remuxed with -c copy). Note the `80 80 80` padded length form
 * before every descriptor payload — that is what a naive parser trips over.
 */
const REAL_ESDS = bytes(`
  65 73 64 73
  00 00 00 00
  03 80 80 80 25
  00 02 00
  04 80 80 80 17
  40 15 00 00 00 00 00 00 00 00 00 00 00
  05 80 80 80 05
  11 90
`);

test("audioObjectType", async (t) => {
  await t.test("reads AAC-LC from a real ffmpeg esds", () => {
    assert.equal(audioObjectType(REAL_ESDS), 2);
  });

  await t.test("does not mistake the padded length bytes for the config", () => {
    // The bug this replaced: it landed on a 0x80 length byte, and 0x80 >> 3 is
    // 16 — not a real AAC profile, so MediaSource refused the whole stream.
    assert.notEqual(audioObjectType(REAL_ESDS), 16);
  });

  await t.test("returns null rather than guessing when there is no esds", () => {
    assert.equal(audioObjectType(bytes("00 11 22 33")), null);
  });

  await t.test("rejects an implausible object type instead of passing it on", () => {
    // Corrupt the config byte to something outside the AAC family.
    const corrupt = Uint8Array.from(REAL_ESDS);
    corrupt[corrupt.length - 2] = 0xf8; // >> 3 === 31
    assert.equal(audioObjectType(corrupt), null);
  });
});

test("codecStringFromInit", async (t) => {
  // avcC: version, profile 0x42 (Baseline), compat 0xc0, level 0x1e (3.0).
  const avcc = new Uint8Array([...ascii("avcC"), 0x01, 0x42, 0xc0, 0x1e]);

  await t.test("derives the exact video codec string", () => {
    assert.equal(codecStringFromInit(avcc), 'video/mp4; codecs="avc1.42c01e"');
  });

  await t.test("adds audio only when an audio track is present", () => {
    const withAudio = new Uint8Array([...avcc, ...ascii("mp4a"), ...REAL_ESDS]);
    assert.equal(codecStringFromInit(withAudio), 'video/mp4; codecs="avc1.42c01e,mp4a.40.2"');
  });

  await t.test("falls back to AAC-LC when the descriptor cannot be walked", () => {
    // Audio track present but no parseable esds — guessing LC beats refusing.
    const odd = new Uint8Array([...avcc, ...ascii("mp4a")]);
    assert.equal(codecStringFromInit(odd), 'video/mp4; codecs="avc1.42c01e,mp4a.40.2"');
  });

  await t.test("returns null when there is no video configuration at all", () => {
    assert.equal(codecStringFromInit(bytes("00 01 02 03")), null);
  });
});
