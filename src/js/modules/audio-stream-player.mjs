import { BufferedStreamReader } from './buffered-stream-reader.mjs';

/* Plays one URL over a sequence of independent playback sessions.
 *
 * A session owns exactly one download reader, one AudioContext, one set of
 * scheduled source nodes, and one session id sent to the decoder worker.
 * Stopping/closing a session tears down all three layers synchronously, and
 * every asynchronous callback (reader progress, worker messages, node
 * "ended", pause/resume promises) is checked against the session id it was
 * created for.  Callbacks that arrive late are ignored so they can never
 * create AudioBuffers for, or alter the counters of, a newer session.
 */
export class AudioStreamPlayer {
  // Session ids must be unique across sessions/players.  A counter is safer
  // than a clock value, which can repeat and is not a session marker.
  static _sessionCounter = 0;

  // these shouldn't change once set
  _worker;
  _url;
  _readBufferSize;

  // these are reset
  _sessionId             // used to prevent race conditions between cancel/starts
  _audioCtx;             // Created/Closed when this player starts/stops audio
  _reader;
  _audioSrcNodes         // Used to fix Safari Bug https://github.com/AnthumChris/fetch-stream-audio/issues/1
  _totalTimeScheduled    // time scheduled of all AudioBuffers
  _playStartedAt         // audioContext.currentTime of first sched
  _abCreated;            // AudioBuffers created
  _abEnded;              // AudioBuffers played/ended
  _skips;                // audio skipping caused by slow download

  constructor(url, readBufferSize, decoderName) {
    switch (decoderName) {
      case 'PCM': this._worker =  new Worker('../worker-decoder-wav.js'); break;
      case 'OPUS': this._worker = new Worker('../worker-decoder-opus.js'); break;
      default: throw Error('Unsupported decoderName', decoderName);
    }

    this._worker.onerror = event => {
      this._updateState({ error: event.message });
    };
    this._worker.onmessage = this._onWorkerMessage.bind(this);

    // pause for now
    // this._audioCtx.suspend().then(_ => console.log('audio paused'));

    this._url = url;
    this._readBufferSize = readBufferSize;
    this._reset();
  }

  _reset() {
    if (this._sessionId) {
      performance.clearMarks(this._downloadMarkKey);
    }

    this._sessionId = null;
    this._audioCtx = null;
    this._reader = null;
    this._audioSrcNodes = [];
    this._totalTimeScheduled = 0;
    this._playStartedAt = 0;
    this._abCreated = 0;
    this._abEnded = 0;
    this._skips = 0;
  }

  // true only for callbacks/messages belonging to the active session
  _isCurrentSession(sessionId) {
    return sessionId !== null &&
           sessionId !== undefined &&
           this._sessionId === sessionId;
  }

  close() {
    const audioCtx = this._audioCtx;

    // 3. scheduling layer: stop nodes and detach their callbacks first so a
    // late "ended" event cannot change the next session's counters.
    for (let node of this._audioSrcNodes) {
      try {
        node.onended = null;
        node.stop();
        node.disconnect();
      } catch (e) {
        // node may already be stopped or disconnected
      }
    }
    this._audioSrcNodes = [];

    // 1. read layer: abort the download and throw away the partial read buffer
    if (this._reader) {
      this._reader.abort();
      this._reader = null;
    }

    // 2. decode layer: tell the worker this session is over so it can drop its
    // playback buffer and any pending tail-frame timer immediately.
    if (this._worker) {
      this._worker.postMessage({ reset: true });
    }

    if (audioCtx) {
      try {
        const suspended = audioCtx.suspend();
        if (suspended && suspended.catch) suspended.catch(_ => {});
      } catch (e) { /* context may already be closed */ }

      try {
        const closed = audioCtx.close();
        if (closed && closed.catch) closed.catch(_ => {});
      } catch (e) { /* context may already be closed */ }
    }
    this._audioCtx = null;

    this._reset();
  }

  start() {
    // Starting again must never inherit readers, nodes, or state from a
    // session that is still active.
    if (this._sessionId) {
      this.close();
    }

    const sessionId = ++AudioStreamPlayer._sessionCounter;
    this._sessionId = sessionId;

    performance.mark(this._downloadMarkKey);
    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const reader = new BufferedStreamReader(new Request(this._url), this._readBufferSize);

    // Capture the session id in each callback; anything arriving after a
    // reset/replay is discarded before it can touch progress counters or the
    // decoder.
    reader.onRead = data => {
      if (this._isCurrentSession(sessionId)) {
        this._downloadProgress(data);
      }
    };
    reader.onBufferFull = data => {
      if (this._isCurrentSession(sessionId)) {
        this._decode(data, sessionId);
      }
    };

    reader.read()
    .catch(e => {
      if (this._isCurrentSession(sessionId)) {
        this._updateState({ error: e.toString() });
      }
    });

    this._reader = reader;
    this.resume();
  }

  pause() {
    const audioCtx = this._audioCtx,
          sessionId = this._sessionId;

    if (!audioCtx) return;

    if (!audioCtx.suspend) return;

    audioCtx.suspend()
      .then(_ => {
        // ignore resolution for a context/session that was since replaced
        if (this._isCurrentSession(sessionId) && this._audioCtx === audioCtx) {
          this._updateState({ playState: 'paused'});
        }
      })
      .catch(_ => {});
  }

  resume() {
    const audioCtx = this._audioCtx,
          sessionId = this._sessionId;

    if (!audioCtx) return;

    audioCtx.resume()
      .then(_ => {
        if (this._isCurrentSession(sessionId) && this._audioCtx === audioCtx) {
          this._updateState({ playState: 'playing'});
        }
      })
      .catch(_ => {});
  }

  _updateState(props) {
    const abState = !this._abCreated? {} : {
      abCreated: this._abCreated,
      abEnded: this._abEnded,
      abRemaining: this._abCreated - this._abEnded,
      skips: this._skips
    };
    const state = Object.assign(abState, props);
    if (this.onUpdateState) {
      this.onUpdateState(state);
    }
  }

  _decode({ bytes }, sessionId) {
    // Don't send empty chunks (e.g. the final flush of an aborted session)
    if (!bytes || !bytes.byteLength) return;
    this._worker.postMessage({ decode: bytes.buffer, sessionId }, [bytes.buffer]);
  }

  // prevent race condition by checking sessionId
  _onWorkerMessage(event) {
    const {decoded, sessionId} = event.data || {};

    if (!decoded || !decoded.channelData) return;

    // A message produced by a previous session must not create an AudioBuffer
    // or touch the active session's counters.
    if (!this._isCurrentSession(sessionId)) {
      return;
    }

    this._schedulePlayback(decoded, sessionId);
  }

  _downloadProgress({ bytes, totalRead, totalBytes, done }) {
    this._updateState({
      bytesRead: totalRead,
      bytesTotal: totalBytes,
      dlRate: totalRead*8 / (performance.now() - this._getDownloadStartTime())
    });
    // console.log(done, (totalRead/totalBytes*100).toFixed(2) );
  }

  get _downloadMarkKey() {
    return `download-start-${this._sessionId}`;
  }
  _getDownloadStartTime() {
    return performance.getEntriesByName(this._downloadMarkKey)[0].startTime;
  }

  _schedulePlayback({channelData, length, numberOfChannels, sampleRate}, sessionId) {
    if (!this._isCurrentSession(sessionId) || !this._audioCtx) return;

    const audioSrc = this._audioCtx.createBufferSource(),
          audioBuffer = this._audioCtx.createBuffer(numberOfChannels, length, sampleRate);

    audioSrc.onended = () => {
      const idx = this._audioSrcNodes.indexOf(audioSrc);
      if (idx !== -1) {
        this._audioSrcNodes.splice(idx, 1);
      }
      // The node may outlive its session (e.g. during teardown); never let it
      // adjust the new session's played count.
      if (!this._isCurrentSession(sessionId)) return;

      this._abEnded++;
      this._updateState();
    };
    this._abCreated++;
    this._updateState();

    // adding also ensures onended callback is fired in Safari
    this._audioSrcNodes.push(audioSrc);

    // Use performant copyToChannel() if browser supports it
    for (let c=0; c<numberOfChannels; c++) {
      if (audioBuffer.copyToChannel) {
        audioBuffer.copyToChannel(channelData[c], c);
      } else {
        let toChannel = audioBuffer.getChannelData(c);
        for (let i=0; i<channelData[c].byteLength; i++) {
          toChannel[i] = channelData[c][i];
        }
      }
    }

    let startDelay = 0;
    // initialize first play position.  initial clipping/choppiness sometimes occurs and intentional start latency needed
    // read more: https://github.com/WebAudio/web-audio-api/issues/296#issuecomment-257100626
    if (!this._playStartedAt) {
      /* this clips in Firefox, plays */
      // const startDelay = audioCtx.baseLatency || (128 / audioCtx.sampleRate);

      /* this doesn't clip in Firefox (256 value), plays */
      // startDelay = this._audioCtx.baseLatency || (256 / this._audioCtx.sampleRate);

      // 100ms allows enough time for largest 60ms Opus frame to decode
      startDelay = 100 / 1000;

      /* this could be useful for firefox but outputLatency is about 250ms in FF. too long */
      // const startDelay = audioCtx.outputLatency || audioCtx.baseLatency || (128 / audioCtx.sampleRate);

      this._playStartedAt = this._audioCtx.currentTime + startDelay;
      this._updateState({ latency: performance.now() - this._getDownloadStartTime() + startDelay*1000 });
    }

    audioSrc.buffer = audioBuffer;
    audioSrc.connect(this._audioCtx.destination);

    const startAt = this._playStartedAt + this._totalTimeScheduled;
    if (this._audioCtx.currentTime >= startAt) {
      this._skips++;
      this._updateState();
    }
    audioSrc.start(startAt);

    this._totalTimeScheduled+= audioBuffer.duration;
  }
}
