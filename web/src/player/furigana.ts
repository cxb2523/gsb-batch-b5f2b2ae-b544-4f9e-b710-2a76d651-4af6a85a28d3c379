const KANJI = /[々〆ヶ一-龯]/;

export function shouldShowFurigana(surface: string, reading: string): boolean {
  return KANJI.test(surface) && reading !== '' && reading !== surface;
}
