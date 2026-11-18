import MohayonaoWavDecoder from './MohayonaoWavDecoder.js';
import { DecoderSession } from './modules/decoder-session.mjs';

const decoder = new MohayonaoWavDecoder();
const session = new DecoderSession();

self.onmessage = event => {
  const data = event.data || {};

  // Teardown message from the main thread (stop/reset/replay)
  if (data.reset) {
    session.clear();
    // Force RIFF/fmt re-parsing for the next stream
    decoder.reset();
    return;
  }

  const { decode, sessionId } = data;

  if (!decode) return;

  // Every chunk must name the session it belongs to
  if (sessionId === null || sessionId === undefined) return;

  // Ignore chunks from a session that has already ended
  if (session.isEnded(sessionId)) return;

  if (session.set(sessionId)) {
    // New session: format metadata saved from the previous WAV must be
    // re-parsed from this stream's header instead of reused.
    decoder.reset();
  }

  if (!session.isActive(sessionId)) return;

  const decoded = decoder.decodeChunkSync(decode);
  if (!decoded || !decoded.length) return;

  self.postMessage(
    { decoded, sessionId },
    decoded.channelData.map(({ buffer }) => buffer)
  );
};
