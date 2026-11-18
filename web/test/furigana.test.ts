import { describe, expect, it } from 'vitest';
import { shouldShowFurigana } from '../src/player/furigana.js';

describe('shouldShowFurigana', () => {
  it('adds readings only for tokens containing Japanese kanji', () => {
    expect(shouldShowFurigana('契約', 'けいやく')).toBe(true);
    expect(shouldShowFurigana('洗い物', 'あらいもの')).toBe(true);
    expect(shouldShowFurigana('は', 'は')).toBe(false);
    expect(shouldShowFurigana('です', 'です')).toBe(false);
  });
});
