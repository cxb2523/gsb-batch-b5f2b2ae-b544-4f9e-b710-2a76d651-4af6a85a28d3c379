let roundSequence = 0;

/**
 * Creates a stable identity for a single round. The id is persisted with the
 * session so restore and settlement logic agree on which round is being played.
 */
export function createRoundId() {
  roundSequence += 1;
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `round-${randomPart}-${roundSequence}`;
}
