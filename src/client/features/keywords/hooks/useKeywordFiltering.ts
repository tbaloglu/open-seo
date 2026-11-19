import { useMemo } from "react";
import { sortBy } from "remeda";
import { parseTerms } from "@/client/features/keywords/utils";
import type { KeywordResearchRow } from "@/types/keywords";
import {
  parseIntentFilter,
  type KeywordFilterValues,
} from "@/client/features/keywords/keywordResearchTypes";
import type { SortDir, SortField } from "@/client/features/keywords/components";
import { groupSharedVolumeRows } from "@/client/features/keywords/groupSharedVolumeRows";
import { foldedTermSource } from "@/shared/text-match";

/**
 * Whether a keyword has a word starting with one of the topics, or null with
 * no topics. Turkish adds suffixes, so "turşu" keeps "Turşusu" and "turşucu";
 * case and the four i-letters fold, so "ISPARTA" keeps "ısparta".
 */
function topicMatcher(value: string) {
  const topics = parseTerms(value);
  if (topics.length === 0) return null;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])(?:${topics.map(foldedTermSource).join("|")})`,
    "iu",
  );
  return (keyword: string) => pattern.test(keyword.normalize("NFD"));
}

export function applyKeywordFiltersAndSort(params: {
  rows: KeywordResearchRow[];
  filters: KeywordFilterValues;
  sortField: SortField;
  sortDir: SortDir;
}): KeywordResearchRow[] {
  const includeTerms = parseTerms(params.filters.include);
  const excludeTerms = parseTerms(params.filters.exclude);
  const selectedIntents = parseIntentFilter(params.filters.intents);
  const matchesTopic = topicMatcher(params.filters.topics);

  const filtered = params.rows.filter((row) => {
    const haystack = row.keyword.toLowerCase();
    if (
      includeTerms.length > 0 &&
      !includeTerms.every((term) => haystack.includes(term))
    ) {
      return false;
    }
    if (excludeTerms.some((term) => haystack.includes(term))) {
      return false;
    }
    if (matchesTopic && !matchesTopic(row.keyword)) return false;

    if (selectedIntents.length > 0 && !selectedIntents.includes(row.intent)) {
      return false;
    }

    const vol = row.searchVolume ?? 0;
    const cpc = row.cpc ?? 0;
    const kd = row.keywordDifficulty ?? 0;

    if (params.filters.minVol && vol < Number(params.filters.minVol))
      return false;
    if (params.filters.maxVol && vol > Number(params.filters.maxVol))
      return false;
    if (params.filters.minCpc && cpc < Number(params.filters.minCpc))
      return false;
    if (params.filters.maxCpc && cpc > Number(params.filters.maxCpc))
      return false;
    if (params.filters.minKd && kd < Number(params.filters.minKd)) return false;
    if (params.filters.maxKd && kd > Number(params.filters.maxKd)) return false;
    return true;
  });

  if (params.sortField === "keyword") {
    return sortBy(filtered, [(row) => row.keyword, params.sortDir]);
  }
  if (params.sortField === "searchVolume") {
    return sortBy(filtered, [(row) => row.searchVolume ?? -1, params.sortDir]);
  }
  if (params.sortField === "cpc") {
    return sortBy(filtered, [(row) => row.cpc ?? -1, params.sortDir]);
  }
  if (params.sortField === "competition") {
    return sortBy(filtered, [(row) => row.competition ?? -1, params.sortDir]);
  }

  return sortBy(filtered, [
    (row) => row.keywordDifficulty ?? -1,
    params.sortDir,
  ]);
}

export function useKeywordFiltering(params: {
  rows: KeywordResearchRow[];
  searchedKeyword: string;
  groupKeywords: boolean;
  filters: KeywordFilterValues;
  sortField: SortField;
  sortDir: SortDir;
}) {
  // Group after filtering so a variant that passes the filters on its own
  // (say, a lower difficulty) is never hidden behind one that does not.
  const filteredRows = useMemo(() => {
    const rows = applyKeywordFiltersAndSort({
      rows: params.rows,
      filters: params.filters,
      sortField: params.sortField,
      sortDir: params.sortDir,
    });
    return groupSharedVolumeRows(
      rows,
      params.searchedKeyword,
      params.groupKeywords,
    );
  }, [
    params.filters,
    params.groupKeywords,
    params.rows,
    params.searchedKeyword,
    params.sortDir,
    params.sortField,
  ]);

  // The topic filter can drop most of a blended result set, so the page says
  // how many rows it hid on its own.
  const topicHiddenCount = useMemo(() => {
    const matchesTopic = topicMatcher(params.filters.topics);
    return matchesTopic
      ? params.rows.filter((row) => !matchesTopic(row.keyword)).length
      : 0;
  }, [params.filters.topics, params.rows]);

  const activeFilterCount = useMemo(
    () =>
      Object.values(params.filters).filter((value) => value.trim() !== "")
        .length,
    [params.filters],
  );

  return {
    filteredRows,
    activeFilterCount,
    topicHiddenCount,
  };
}
