import { OpusStreamDecoder } from 'opus-stream-decoder';
import { DecodedAudioPlaybackBuffer } from './modules/decoded-audio-playback-buffer.mjs';
import { DecoderSession } from './modules/decoder-session.mjs';

const session = new DecoderSession();
const playbackBuffer = new DecodedAudioPlaybackBuffer({ onFlush });

let flushTimeoutId = null;
let decoder = null;
let decoderSnapshot = null;   // session the current decoder instance belongs to
let bufferSnapshot = null;    // session the samples in playbackBuffer belong to

function clearPendingFlush() {
  if (flushTimeoutId !== null) {
    clearTimeout(flushTimeoutId);
    flushTimeoutId = null;
  }
}

function releaseDecoder() {
  if (decoder && typeof decoder.free === 'function') {
    try { decoder.free(); } catch (e) { /* already freed */ }
  }
  decoder = null;
  decoderSnapshot = null;
}

/* Drops all buffered, not-yet-posted samples, the tail-frame timer, and the
 * decoder instance.  Called whenever a session starts or ends so samples from
 * an old stream can never be glued onto another stream. */
function resetPlaybackState() {
  clearPendingFlush();
  playbackBuffer.reset();
  releaseDecoder();
  bufferSnapshot = null;
}

/* A decoder instance is bound to the snapshot of the session that created it,
 * so even output that escapes a freed decoder is attributable and rejected. */
function getDecoder(snapshot) {
  if (decoder && decoderSnapshot &&
      decoderSnapshot.sessionId === snapshot.sessionId &&
      decoderSnapshot.generation === snapshot.generation) {
    return decoder;
  }

  releaseDecoder();
  decoderSnapshot = snapshot;
  decoder = new OpusStreamDecoder({
    onDecode: decoded => onDecode(snapshot, decoded)
  });

  return decoder;
}

/* Returns false when the message belongs to a session that already ended
 * (delivered late around a reset) and therefore must not be decoded. */
function beginSession(sessionId) {
  if (session.isEnded(sessionId)) {
    return false;
  }

  if (session.set(sessionId)) {
    // brand-new session: previous decoder, buffers, and timer are stale
    resetPlaybackState();
  }

  return session.isActive(sessionId);
}

self.onmessage = async (evt) => {
  const data = evt.data || {};

  // Teardown message from the main thread (stop/reset/replay)
  if (data.reset) {
    resetPlaybackState();
    session.clear();
    return;
  }

  if (!data.decode) return;

  // Every chunk must name the session it belongs to
  if (data.sessionId === null || data.sessionId === undefined) return;

  if (!beginSession(data.sessionId)) return;

  // Snapshot before awaiting: if a reset/new session happens while the
  // decoder initializes, this chunk belongs to the old session and is dropped.
  const snapshot = session.snapshot();
  const activeDecoder = getDecoder(snapshot);

  await activeDecoder.ready;

  if (!session.isCurrent(snapshot) || activeDecoder !== decoder) return;

  activeDecoder.decode(new Uint8Array(data.decode));
};

function onDecode(snapshot, { left, right, samplesDecoded, sampleRate }) {
  // Decoder recovers when it receives new files, and samplesDecoded is negative.
  // For cause, see https://github.com/AnthumChris/opus-stream-decoder/issues/7
  if (samplesDecoded < 0) {
    return;
  }

  // Late decoder output from a closed/replaced session must not be buffered.
  if (!session.isCurrent(snapshot)) {
    return;
  }

  bufferSnapshot = snapshot;
  playbackBuffer.add({ left, right});
  scheduleLastFlush(snapshot);
}

function onFlush({ left, right }) {
  // Flush whatever session the buffered samples belong to; never retag them
  // as a newer (or ended) session.
  if (!session.isCurrent(bufferSnapshot)) {
    return;
  }

  if (!left.length) {
    return;
  }

  const decoded = {
    channelData: [left, right],
    length: left.length,
    numberOfChannels: 2,
    sampleRate: 48000
  };

  self.postMessage(
    { decoded, sessionId: bufferSnapshot.sessionId },
    [
      decoded.channelData[0].buffer,
      decoded.channelData[1].buffer
    ]
  );
}

// No End of file is signaled from decoder. This ensures last bytes always flush
function scheduleLastFlush(snapshot) {
  clearPendingFlush();
  flushTimeoutId = setTimeout(_ => {
    flushTimeoutId = null;

    // A timer armed by an old session must never fire into a newer one.
    if (!session.isCurrent(snapshot)) {
      return;
    }

    playbackBuffer.flush();
  }, 100);
}
