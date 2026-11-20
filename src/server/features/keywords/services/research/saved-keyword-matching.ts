import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import {
  legacyTurkicLowercase,
  parseStoredTimestamp,
  strayDotVariants,
  writtenBeforeLegacyCutoff,
} from "@/server/lib/legacy-keyword-text";
import type { ResolvedSaveKeywordsInput } from "@/types/schemas/keywords";
import { normalizeKeyword } from "./helpers";

// Bound concurrent metric writes, as the metrics refresh does.
const METRIC_COPY_BATCH_SIZE = 100;

/**
 * Maps each requested keyword (lower-cased the current way) to the text of
 * the project's row for it, so a re-save updates that row instead of adding
 * a near duplicate. In order:
 * 1. the row with exactly that text;
 * 2. a row plain toLowerCase() wrote with a combining dot for an "İ"
 *    ("i\u0307stanbul" for "istanbul"), any language;
 * 3. in Turkish or Azerbaijani, the row plain toLowerCase() stored for the
 *    same input before the cutoff ("isparta oteli" for "Isparta oteli", now
 *    "ısparta oteli"). Only an old row and only that exact text: "kir" and
 *    "kır" are different words, so later rows never stand in for each other.
 * A text requested in the same save is never used as another keyword's row.
 * Every candidate is looked up by its exact text on the keyword index.
 */
export async function matchStoredKeywords(
  input: ResolvedSaveKeywordsInput,
): Promise<Map<string, string>> {
  const legacyByKeyword = new Map<string, Set<string>>();
  for (const raw of input.keywords) {
    const keyword = normalizeKeyword(raw, input.languageCode);
    if (!keyword) continue;
    const legacy = legacyByKeyword.get(keyword) ?? new Set<string>();
    const old = legacyTurkicLowercase(raw, input.languageCode);
    if (old) legacy.add(old);
    legacyByKeyword.set(keyword, legacy);
  }
  const dottedByKeyword = new Map(
    [...legacyByKeyword.keys()].map((keyword) => [
      keyword,
      strayDotVariants(keyword),
    ]),
  );
  const candidates = new Set([
    ...legacyByKeyword.keys(),
    ...[...legacyByKeyword.values()].flatMap((texts) => [...texts]),
    ...[...dottedByKeyword.values()].flat(),
  ]);
  const rows = await KeywordResearchRepository.listSavedKeywordRowsByKeywords({
    ...input,
    keywords: [...candidates],
  });
  const rowByText = new Map(rows.map((row) => [row.keyword, row]));

  const used = new Set<string>();
  const storedByKeyword = new Map<string, string>();
  for (const [keyword, legacy] of legacyByKeyword) {
    const isFree = (text: string) =>
      rowByText.has(text) && !used.has(text) && !legacyByKeyword.has(text);
    const stored = rowByText.has(keyword)
      ? keyword
      : (dottedByKeyword.get(keyword)?.find(isFree) ??
        [...legacy].find((text) => {
          const row = rowByText.get(text);
          return (
            row && isFree(text) && writtenBeforeLegacyCutoff(row.createdAt)
          );
        }) ??
        keyword);
    used.add(stored);
    storedByKeyword.set(keyword, stored);
  }
  return storedByKeyword;
}

/**
 * Research stores metrics under the current text ("istanbul"). A keyword
 * saved onto an older row ("i\u0307stanbul") without metrics of its own gets
 * them copied under the row's text, which is what the saved list joins on,
 * unless the row already has metrics at least as recent.
 */
export async function copyResearchMetrics(
  input: ResolvedSaveKeywordsInput,
  pairs: [keyword: string, stored: string][],
) {
  if (pairs.length === 0) return;
  const metrics = await KeywordResearchRepository.listKeywordMetrics({
    ...input,
    keywords: pairs.flat(),
  });
  const metricByText = new Map(metrics.map((row) => [row.keyword, row]));
  const copies = pairs.flatMap(([keyword, stored]) => {
    const source = metricByText.get(keyword);
    const target = metricByText.get(stored);
    if (!source) return [];
    if (
      target &&
      parseStoredTimestamp(source.fetchedAt) <=
        parseStoredTimestamp(target.fetchedAt)
    )
      return [];
    return [{ source, stored }];
  });
  for (let i = 0; i < copies.length; i += METRIC_COPY_BATCH_SIZE) {
    await Promise.all(
      copies.slice(i, i + METRIC_COPY_BATCH_SIZE).map(({ source, stored }) =>
        KeywordResearchRepository.upsertKeywordMetric({
          projectId: input.projectId,
          keyword: stored,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          searchVolume: source.searchVolume,
          cpc: source.cpc,
          competition: source.competition,
          keywordDifficulty: source.keywordDifficulty,
          intent: source.intent,
          monthlySearchesJson: source.monthlySearches ?? "[]",
          fetchedAt: source.fetchedAt,
        }),
      ),
    );
  }
}
