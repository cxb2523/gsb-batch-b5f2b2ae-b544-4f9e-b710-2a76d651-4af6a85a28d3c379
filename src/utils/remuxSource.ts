/**
 * Play a container the engine cannot open, by feeding it a remuxed one.
 *
 * WKWebView renders through AVFoundation, which has no Matroska demuxer: a .mkv
 * carrying ordinary H.264 + AAC fails before the first frame, while the same
 * streams inside an .mp4 play perfectly. The relay's /api/remux turns one into
 * the other with `ffmpeg -c copy` — a remux, never a transcode, so nothing is
 * re-encoded and quality is untouched.
 *
 * The result has to go through MediaSource rather than `<video src>`. A piped
 * fragmented MP4 carries `mvhd duration=0` and no `mehd` (verified against a
 * real episode), so the engine would report a non-finite duration and silently
 * disable the scrubber, credits detection and continue-watching. Assigning
 * `mediaSource.duration` from the relay's header fixes all three at once.
 */

export interface RemuxSourceOptions {
  /** Build the relay URL for a given start position. */
  buildUrl: (startSec: number) => string;
  /** Where to begin (resume point), in seconds. */
  startSec?: number;
  onError: (message: string) => void;
  /** Fired once the real duration is known, so the UI can stop guessing. */
  onDuration?: (durationSec: number) => void;
}

export interface RemuxSource {
  /** Move to a position, respawning upstream only if it is not buffered. */
  seek: (toSec: number) => void;
  destroy: () => void;
}

/** Keep this much played video behind the playhead before evicting. */
const BACK_BUFFER_SEC = 45;
/** A seek within a buffered range costs nothing; only leaving it respawns. */
const BUFFERED_TOLERANCE_SEC = 0.5;

const isBuffered = (video: HTMLVideoElement, timeSec: number): boolean => {
  const { buffered } = video;
  for (let i = 0; i < buffered.length; i += 1) {
    if (timeSec >= buffered.start(i) - BUFFERED_TOLERANCE_SEC && timeSec <= buffered.end(i)) {
      return true;
    }
  }
  return false;
};

/** Walk top-level MP4 boxes, descending into the containers we care about. */
const findBox = (data: Uint8Array, type: string): number => {
  const needle = new TextEncoder().encode(type);
  outer: for (let i = 0; i + needle.length <= data.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

/** AAC Low Complexity — what every provider stream seen here actually uses. */
const AAC_LC = 2;

/**
 * Read one MPEG-4 descriptor header, returning its tag and where its payload
 * starts.
 *
 * The length is a chain of 7-bit groups: any byte with the high bit set means
 * another follows. ffmpeg writes the padded 4-byte form (`80 80 80 nn`), so
 * assuming a single length byte lands squarely in the middle of it — which is
 * exactly the bug this replaced. A stray `0x80` read as a config byte yields
 * object type 16, which is not a real AAC profile, and MediaSource refuses the
 * whole stream.
 */
const readDescriptor = (
  data: Uint8Array,
  at: number,
): { tag: number; payload: number } | null => {
  if (at >= data.length) return null;
  const tag = data[at];
  let p = at + 1;
  for (let i = 0; i < 4 && p < data.length; i += 1) {
    const byte = data[p];
    p += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { tag, payload: p };
};

/**
 * Walk esds → ES_Descriptor → DecoderConfig → DecoderSpecificInfo and read the
 * AudioSpecificConfig's top 5 bits. Verified against a real provider episode:
 * config `0x1190` → 2 (AAC-LC).
 */
export const audioObjectType = (init: Uint8Array): number | null => {
  const esds = findBox(init, "esds");
  if (esds < 0) return null;
  let p = esds + 4 + 4; // box name, then version+flags

  const es = readDescriptor(init, p);
  if (!es || es.tag !== 0x03) return null;
  p = es.payload + 2; // ES_ID
  const flags = init[p];
  p += 1;
  if (flags === undefined) return null;
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + (init[p] ?? 0); // URL
  if (flags & 0x20) p += 2; // OCR_ES_ID

  const config = readDescriptor(init, p);
  if (!config || config.tag !== 0x04) return null;
  // objectTypeIndication + streamType/bufferSize (4) + max/avg bitrate (8)
  p = config.payload + 13;

  const specific = readDescriptor(init, p);
  if (!specific || specific.tag !== 0x05) return null;
  const first = init[specific.payload];
  if (first === undefined) return null;
  const objectType = first >> 3;
  // Only the AAC family is plausible here; anything else means we mis-walked,
  // and guessing wrong makes MediaSource reject a stream that would have played.
  return [1, 2, 3, 4, 5, 29].includes(objectType) ? objectType : null;
};

/**
 * Derive the exact codec string from the init segment.
 *
 * MediaSource rejects an inaccurate one outright, and the profile/level differ
 * per file, so this must be read rather than assumed. `avcC` carries
 * profile/compat/level as three bytes right after its version byte.
 */
export const codecStringFromInit = (init: Uint8Array): string | null => {
  const avcc = findBox(init, "avcC");
  if (avcc < 0) return null;
  const p = avcc + 4; // skip the box name; next byte is configurationVersion
  const profile = init[p + 1];
  const compat = init[p + 2];
  const level = init[p + 3];
  if (profile === undefined || compat === undefined || level === undefined) return null;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const video = `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;

  // Audio is optional — a video-only file must still play.
  if (findBox(init, "mp4a") < 0) return `video/mp4; codecs="${video}"`;
  const objectType = audioObjectType(init) ?? AAC_LC;
  return `video/mp4; codecs="${video},mp4a.40.${objectType}"`;
};

/** Concatenate the chunks read so far, so box parsing can span reads. */
const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/**
 * The init segment is `ftyp` + `moov`; fragments (`moof`) follow. We need the
 * whole of moov before addSourceBuffer, so read until the first moof appears.
 */
const initSegmentComplete = (data: Uint8Array): boolean =>
  findBox(data, "moov") >= 0 && findBox(data, "moof") >= 0;

export const attachRemuxSource = (
  video: HTMLVideoElement,
  options: RemuxSourceOptions,
): RemuxSource => {
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;

  let sourceBuffer: SourceBuffer | null = null;
  let controller: AbortController | null = null;
  /** Cleared on every (re)load so each new stream gets aligned once. */
  let alignedStart = false;
  let destroyed = false;
  let generation = 0;
  const queue: Uint8Array[] = [];
  let appending = false;

  const pumpQueue = () => {
    if (destroyed || appending || !sourceBuffer || sourceBuffer.updating) return;
    // Once the element has errored, MediaSource closes and every append throws
    // InvalidStateError. That is a symptom of the first failure, not a new
    // fault, so stop rather than bury the real cause under a second message.
    if (mediaSource.readyState !== "open") {
      queue.length = 0;
      return;
    }
    const next = queue.shift();
    if (!next) return;
    appending = true;
    try {
      sourceBuffer.appendBuffer(next as BufferSource);
    } catch (error) {
      appending = false;
      // Quota is recoverable: drop the back-buffer and retry once.
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        queue.unshift(next);
        evictBackBuffer(true);
        return;
      }
      // Same reasoning: an append that fails because the source went away is
      // downstream of whatever actually broke.
      if (destroyed || mediaSource.readyState !== "open") return;
      options.onError(`Could not buffer the remuxed stream: ${(error as Error).message}`);
    }
  };

  const evictBackBuffer = (aggressive = false) => {
    if (!sourceBuffer || sourceBuffer.updating || sourceBuffer.buffered.length === 0) return;
    const keepFrom = video.currentTime - (aggressive ? 5 : BACK_BUFFER_SEC);
    const start = sourceBuffer.buffered.start(0);
    if (keepFrom <= start + 1) return;
    try {
      sourceBuffer.remove(start, keepFrom);
    } catch {
      /* removal is best-effort; a failed evict just means more memory held */
    }
  };

  const onUpdateEnd = () => {
    appending = false;
    // Land the playhead on the data we actually have.
    //
    // delay_moov preserves each track's true starting offset rather than
    // forcing it to zero, so the first sample can begin slightly after 0 (a
    // video dts of 96 was observed). The element, sitting at currentTime 0,
    // would then wait forever for data that will never exist — the length shows
    // but nothing plays.
    if (!alignedStart && sourceBuffer && sourceBuffer.buffered.length > 0) {
      const first = sourceBuffer.buffered.start(0);
      if (video.currentTime < first) video.currentTime = first;
      alignedStart = true;
    }
    evictBackBuffer();
    pumpQueue();
  };

  /** Open a stream at `startSec` and feed it in. Cancels any previous one. */
  const load = async (startSec: number) => {
    const mine = (generation += 1);
    alignedStart = false;
    // Abort the old fetch FIRST: that closes the relay body and lets ffmpeg
    // release the provider connection before we ask for another one. On an
    // account with few slots, that ordering is the difference between working
    // and being refused.
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;

    let response: Response;
    try {
      response = await fetch(options.buildUrl(startSec), { signal, cache: "no-store" });
    } catch (error) {
      if (signal.aborted || destroyed || mine !== generation) return;
      options.onError(`Could not start the remuxed stream: ${(error as Error).message}`);
      return;
    }
    if (destroyed || mine !== generation) return;
    if (!response.ok || !response.body) {
      options.onError(`The remuxer answered ${response.status}.`);
      return;
    }

    const duration = Number(response.headers.get("X-Remux-Duration"));
    /**
     * The offset is what we ASKED for, not where the keyframe landed.
     *
     * The old code used `X-Remux-Start` on the theory that "-ss lands on the
     * keyframe at or before the request, and the fragments themselves are
     * always zero-based". The second half is wrong. Measured against the
     * relay's own argv at `-ss 15.000` on a 10s-GOP source:
     *
     *     output video first packet: pts -4.920000, key_frame=1
     *     output audio first packet: pts  0.000000
     *
     * Both tracks are on the timeline `output_t = file_t - startSec`, and the
     * video leads with a NEGATIVE pts back to its keyframe. So adding
     * `X-Remux-Start` (the keyframe, ~10.08) put the whole timeline a full GOP
     * early: the scrubber, credits detection and subtitles all ran ~5s ahead of
     * the picture. `seek()` below has always used the requested position for
     * exactly this reason; this makes the two agree.
     *
     * The clamp stays: a negative offset would make MediaSource reject the
     * frames outright, and startSec is never negative anyway.
     */
    const timestampOffset = Math.max(0, startSec);

    if (Number.isFinite(duration) && duration > 0) {
      if (mediaSource.readyState === "open" && mediaSource.duration !== duration) {
        try {
          mediaSource.duration = duration;
        } catch {
          /* setting duration can throw while a buffer is updating; harmless */
        }
      }
      options.onDuration?.(duration);
    }

    const reader = response.body.getReader();
    const pending: Uint8Array[] = [];
    let sawInit = sourceBuffer !== null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (destroyed || mine !== generation) {
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (done) break;
        if (!value) continue;

        if (!sawInit) {
          pending.push(value);
          const head = concat(pending);
          if (!initSegmentComplete(head)) continue;
          const mime = codecStringFromInit(head);
          if (!mime || !MediaSource.isTypeSupported(mime)) {
            options.onError(
              mime
                ? `This file remuxes to ${mime}, which this player cannot decode.`
                : "Could not read the remuxed stream's codec information.",
            );
            return;
          }
          sourceBuffer = mediaSource.addSourceBuffer(mime);
          sourceBuffer.mode = "segments";
          sourceBuffer.addEventListener("updateend", onUpdateEnd);
          sourceBuffer.timestampOffset = timestampOffset;
          sawInit = true;
          queue.push(head);
          pending.length = 0;
          pumpQueue();
          continue;
        }

        queue.push(value);
        pumpQueue();
      }
    } catch (error) {
      if (signal.aborted || destroyed || mine !== generation) return;
      options.onError(`The remuxed stream stopped: ${(error as Error).message}`);
      return;
    }

    if (!destroyed && mine === generation && mediaSource.readyState === "open") {
      // Let the element know the stream really ended, or it waits forever.
      const finish = () => {
        if (destroyed || mediaSource.readyState !== "open") return;
        if (sourceBuffer?.updating || queue.length > 0) {
          window.setTimeout(finish, 100);
          return;
        }
        try {
          mediaSource.endOfStream();
        } catch {
          /* already ended */
        }
      };
      finish();
    }
  };

  const onSourceOpen = () => {
    void load(options.startSec ?? 0);
  };
  mediaSource.addEventListener("sourceopen", onSourceOpen, { once: true });

  return {
    seek: (toSec: number) => {
      if (destroyed) return;
      // Inside the buffer this costs nothing — no upstream work at all. That
      // covers back-scrubs and the frame watchdog's micro-nudge, which under a
      // naive design would each re-open the provider.
      if (isBuffered(video, toSec)) return;
      queue.length = 0;
      if (sourceBuffer && !sourceBuffer.updating) {
        try {
          sourceBuffer.abort();
        } catch {
          /* abort is only invalid if the buffer is already gone */
        }
        sourceBuffer.timestampOffset = toSec;
      }
      void load(toSec);
    },
    destroy: () => {
      destroyed = true;
      generation += 1;
      controller?.abort();
      queue.length = 0;
      sourceBuffer?.removeEventListener("updateend", onUpdateEnd);
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        /* nothing to end */
      }
      URL.revokeObjectURL(objectUrl);
      sourceBuffer = null;
    },
  };
};
