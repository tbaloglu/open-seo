import { isTurkicLanguage, lowercaseKeyword } from "@/shared/text-match";

// Keyword rows written before this moment were lower-cased with plain
// toLowerCase(); later rows use lowercaseKeyword. Set to just before the
// deploy that ships lowercaseKeyword, never later.
const LEGACY_NORMALIZATION_CUTOFF = "2026-11-20T04:30:00Z";

/**
 * Plain toLowerCase() turned "İ" into i plus a combining dot (U+0307), in
 * every language. A stored "i\u0307stanbul" reads as "istanbul" without it.
 */
export function withoutStrayDot(text: string) {
  return text.normalize("NFC").replace(/i\u0307/g, "i");
}

/**
 * Texts plain toLowerCase() may have stored for `keyword` when some of its
 * "i"s were typed as "İ" ("i\u0307stanbul" for "istanbul"). With up to two
 * "i"s, every combination; with more, only the first, the word-initial ones
 * and all of them (sentence case, title case, all caps), which keeps a
 * 500-keyword save to a few dozen queries. An unusual older row may be missed
 * (it then gets a twin, nothing lost).
 */
export function strayDotVariants(keyword: string): string[] {
  const positions = [...keyword.matchAll(/i/g)].map((match) => match.index);
  let subsets: number[][];
  if (positions.length <= 2) {
    subsets = Array.from({ length: 2 ** positions.length - 1 }, (_, i) =>
      positions.filter((_position, bit) => ((i + 1) >> bit) & 1),
    );
  } else {
    const initial = positions.filter(
      (position) => position === 0 || /\s/.test(keyword[position - 1]),
    );
    subsets = [[positions[0]], initial, positions].filter(
      (subset) => subset.length > 0,
    );
  }
  return [
    ...new Set(
      subsets.map((subset) =>
        subset.reduceRight(
          (text, position) =>
            `${text.slice(0, position + 1)}\u0307${text.slice(position + 1)}`,
          keyword,
        ),
      ),
    ),
  ];
}

/**
 * What plain toLowerCase() stored for `raw` in Turkish or Azerbaijani, when
 * that differs from the current text ("isparta" for "Isparta", now
 * "ısparta"); null otherwise.
 */
export function legacyTurkicLowercase(raw: string, languageCode: string) {
  if (!isTurkicLanguage(languageCode)) return null;
  const trimmed = raw.trim();
  const old = trimmed.toLowerCase();
  return old !== lowercaseKeyword(trimmed, languageCode) ? old : null;
}

/**
 * A stored timestamp in milliseconds. SQLite defaults store
 * "YYYY-MM-DD HH:MM:SS" (UTC, no T or Z); Postgres and app writes store ISO.
 */
export function parseStoredTimestamp(value: string) {
  return Date.parse(
    value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
  );
}

/** Whether a row was written by the old lower-casing. */
export function writtenBeforeLegacyCutoff(createdAt: string) {
  return (
    parseStoredTimestamp(createdAt) < Date.parse(LEGACY_NORMALIZATION_CUTOFF)
  );
}
