import { isTurkicLanguage, lowercaseKeyword } from "@/shared/text-match";

// Keyword rows written before this moment were lower-cased with plain
// toLowerCase(); later rows use lowercaseKeyword.
const LEGACY_NORMALIZATION_CUTOFF = Date.parse("2026-11-21T00:00:00Z");

/**
 * Plain toLowerCase() turned "İ" into i plus a combining dot (U+0307), in
 * every language. A stored "i\u0307stanbul" reads as "istanbul" without it.
 */
export function withoutStrayDot(text: string) {
  return text.normalize("NFC").replace(/i\u0307/g, "i");
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
 * Whether a row was written by the old lower-casing. SQLite defaults store
 * "YYYY-MM-DD HH:MM:SS" (UTC, no T or Z); Postgres stores ISO text.
 */
export function writtenBeforeLegacyCutoff(createdAt: string) {
  const parsed = Date.parse(
    createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`,
  );
  return parsed < LEGACY_NORMALIZATION_CUTOFF;
}
