import { lowercaseKeyword } from "@/shared/text-match";
import type { EnrichedKeyword } from "./helpers";

export type KeywordSource = "related" | "suggestions" | "ideas";
export type KeywordMode = "auto" | KeywordSource;
/**
 * Where research rows actually came from. "google_ads" is not requestable as
 * a mode (it's the automatic source for countries Labs doesn't support), and
 * "blended" is auto mode's suggestions + ideas mix.
 */
export type ResearchSource = KeywordSource | "google_ads" | "blended";

export const MIN_NON_SEED_FOR_AUTO = 5;

export function countNonSeedKeywords(
  rows: EnrichedKeyword[],
  seedKeyword: string,
  languageCode: string,
): number {
  const normalizedSeed = lowercaseKeyword(seedKeyword.trim(), languageCode);
  return rows.filter((row) => row.keyword !== normalizedSeed).length;
}
