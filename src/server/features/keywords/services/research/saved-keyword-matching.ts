import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import {
  legacyTurkicLowercase,
  withoutStrayDot,
  writtenBeforeLegacyCutoff,
} from "@/server/lib/legacy-keyword-text";
import type { ResolvedSaveKeywordsInput } from "@/types/schemas/keywords";
import { normalizeKeyword } from "./helpers";

/**
 * Maps each requested keyword (lower-cased the current way) to the text of
 * the project's row for it, so a re-save updates that row instead of adding
 * a near duplicate. In order:
 * 1. the row with exactly that text;
 * 2. a row with a stray combining dot ("i\u0307stanbul", which plain
 *    toLowerCase() made of "İstanbul") that reads the same without it;
 * 3. in Turkish or Azerbaijani, the row plain toLowerCase() stored for the
 *    same input before the cutoff ("isparta oteli" for "Isparta oteli", now
 *    "ısparta oteli"). Only an old row and only that exact text: "kir" and
 *    "kır" are different words, so later rows never stand in for each other.
 * A text requested in the same save is never used as another keyword's row.
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
  const keywords = [...legacyByKeyword.keys()];
  const legacyTexts = [...legacyByKeyword.values()]
    .flatMap((texts) => [...texts])
    .filter((text) => !legacyByKeyword.has(text));
  const [rows, dottedRows] = await Promise.all([
    KeywordResearchRepository.listSavedKeywordRowsByKeywords({
      ...input,
      keywords: [...keywords, ...legacyTexts],
    }),
    keywords.some((keyword) => keyword.includes("i"))
      ? KeywordResearchRepository.listSavedKeywordsWithStrayDot(input)
      : [],
  ]);
  const rowByText = new Map(rows.map((row) => [row.keyword, row]));
  const used = new Set<string>();
  const storedByKeyword = new Map<string, string>();
  for (const [keyword, legacy] of legacyByKeyword) {
    const isFree = (text: string) =>
      !used.has(text) && !legacyByKeyword.has(text);
    const stored = rowByText.has(keyword)
      ? keyword
      : (dottedRows.find(
          (row) =>
            isFree(row.keyword) && withoutStrayDot(row.keyword) === keyword,
        )?.keyword ??
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
 * a copy under the row's text, which is what the saved list joins on.
 */
export async function copyResearchMetrics(
  input: ResolvedSaveKeywordsInput,
  pairs: [keyword: string, stored: string][],
) {
  await Promise.all(
    pairs.map(async ([keyword, stored]) => {
      const metric = await KeywordResearchRepository.getKeywordMetric({
        ...input,
        keyword,
      });
      if (!metric) return;
      await KeywordResearchRepository.upsertKeywordMetric({
        projectId: input.projectId,
        keyword: stored,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        searchVolume: metric.searchVolume,
        cpc: metric.cpc,
        competition: metric.competition,
        keywordDifficulty: metric.keywordDifficulty,
        intent: metric.intent,
        monthlySearchesJson: metric.monthlySearches ?? "[]",
        fetchedAt: metric.fetchedAt,
      });
    }),
  );
}
