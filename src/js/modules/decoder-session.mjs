/* Tracks which playback session a decoder worker currently belongs to.
 *
 * Both decoder workers (Opus/WebAssembly and WAV/JavaScript) use this same
 * check.  The main thread stamps every decode request with a session id and
 * sends `{ reset: true }` when a session is torn down.  Asynchronous decoder
 * output is only forwarded when it can still be proven to belong to the
 * active session; everything else is dropped.
 *
 * Session ids come from an incrementing counter on the main thread, so a
 * session id that has already ended can never legitimately begin again.  The
 * worker remembers every ended id to reject messages that were queued
 * before/around a reset.
 */
export class DecoderSession {
  // Enough history to reject messages that were queued around a reset, without
  // growing forever in a long-lived worker.  Evicted ids are still rejected by
  // the main thread's own session check.
  static maxEndedIds = 64;

  _sessionId = null;
  _generation = 0;
  _endedIds = new Set();

  _rememberEnded(sessionId) {
    if (sessionId === null) return;

    this._endedIds.add(sessionId);
    while (this._endedIds.size > DecoderSession.maxEndedIds) {
      this._endedIds.delete(this._endedIds.values().next().value);
    }
  }

  get sessionId() {
    return this._sessionId;
  }

  get generation() {
    return this._generation;
  }

  isActive(sessionId) {
    return sessionId !== null &&
           sessionId !== undefined &&
           this._sessionId === sessionId;
  }

  /* true when this id belonged to a session that has since been ended */
  isEnded(sessionId) {
    return sessionId !== null &&
           sessionId !== undefined &&
           this._endedIds.has(sessionId);
  }

  /* Marks `sessionId` as the active session.  Returns true when this begins a
   * new session (i.e. callers must discard decoder/playback leftovers). */
  set(sessionId) {
    if (this.isActive(sessionId)) {
      return false;
    }

    if (this._sessionId !== null) {
      this._rememberEnded(this._sessionId);
    }

    this._sessionId = sessionId === undefined ? null : sessionId;
    this._generation++;
    return true;
  }

  /* Ends the active session.  Any in-flight async work keeps the old
   * generation and therefore fails isCurrent(). */
  clear() {
    if (this._sessionId !== null) {
      this._rememberEnded(this._sessionId);
    }

    this._sessionId = null;
    this._generation++;
  }

  /* Captures the session/generation before async work so late messages can be
   * validated against the exact session that produced them. */
  snapshot() {
    return { sessionId: this._sessionId, generation: this._generation };
  }

  isCurrent(snapshot) {
    return !!snapshot &&
           snapshot.sessionId !== null &&
           snapshot.sessionId === this._sessionId &&
           snapshot.generation === this._generation;
  }
}
