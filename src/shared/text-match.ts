/**
 * A search term as a regular expression source, to run with the `iu` flags
 * against text normalized to NFD. Whitespace matches any run of whitespace.
 *
 * The `i` flag folds I to i only. Turkish writes i/İ and ı/I (İ is I +
 * combining dot after NFD), so "ISPARTA" is "ısparta" and "İstanbul" is
 * "istanbul": every i-letter matches every other.
 */
export function foldedTermSource(term: string) {
  return term
    .normalize("NFD")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/[iIı]\u0307?/g, "[iIı]\\u0307?");
}

/**
 * A search term folded to a key for exact-phrase comparison: the same
 * i-letter folding as foldedTermSource (i, I, ı and İ are one letter), lower
 * case, and runs of whitespace collapsed. Other diacritics stay, so "şeker"
 * and "seker" are different keys.
 */
export function foldedTermKey(term: string) {
  return term
    .normalize("NFD")
    .replace(/[iIı]\u0307?/g, "i")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A keyword lower-cased the way its language writes it. Turkish and
 * Azerbaijani pair I with ı and İ with i, so "KIRMIZI" is "kırmızı" there and
 * "kirmizi" elsewhere. In every language "İ" becomes a plain "i": default
 * lower-casing gives i plus a combining dot (U+0307), which looks the same
 * but never equals "i".
 */
export function lowercaseKeyword(text: string, languageCode: string) {
  const lower = /^(tr|az)\b/i.test(languageCode)
    ? text.toLocaleLowerCase(languageCode)
    : text.toLowerCase();
  return lower.normalize("NFC").replace(/i̇/g, "i");
}
