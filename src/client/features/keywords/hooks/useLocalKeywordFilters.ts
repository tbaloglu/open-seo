import { useCallback, useEffect } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { z } from "zod";
import {
  EMPTY_FILTERS,
  type KeywordFilterValues,
} from "@/client/features/keywords/keywordResearchTypes";

// The research filters, kept per project in this browser. Topic words are the
// exception: they are saved on the server (useProjectTopicWords), so they
// start empty here and are never written to storage. A blob saved before that
// keeps its topics until useProjectTopicWords has uploaded them.

function storageKey(projectId: string) {
  return `keyword-default-filters:${projectId}`;
}

export const filterValuesSchema = z.object({
  include: z.string(),
  exclude: z.string(),
  minVol: z.string(),
  maxVol: z.string(),
  minCpc: z.string(),
  maxCpc: z.string(),
  minKd: z.string(),
  maxKd: z.string(),
  // Defaulted so filter blobs persisted before the intent filter existed still
  // parse (missing key -> "") instead of discarding the user's saved filters.
  intents: z.string().default(""),
  topics: z.string().default(""),
});

function loadFiltersFromStorage(projectId: string): KeywordFilterValues {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return EMPTY_FILTERS;
    return filterValuesSchema.parse(JSON.parse(raw));
  } catch {
    return EMPTY_FILTERS;
  }
}

function saveFiltersToStorage(projectId: string, filters: KeywordFilterValues) {
  try {
    const hasAnyFilter = Object.values(filters).some((v) => v.trim() !== "");
    if (hasAnyFilter) {
      localStorage.setItem(storageKey(projectId), JSON.stringify(filters));
    } else {
      localStorage.removeItem(storageKey(projectId));
    }
  } catch {
    // storage full or unavailable
  }
}

/** Topic words this browser saved before they moved to the server. */
export function readLegacyTopics(projectId: string): string {
  return loadFiltersFromStorage(projectId).topics;
}

/** Drops the topic words from this browser's saved filters. */
export function clearLegacyTopics(projectId: string) {
  saveFiltersToStorage(projectId, {
    ...loadFiltersFromStorage(projectId),
    topics: "",
  });
}

export function useLocalKeywordFilters(projectId: string) {
  const filtersForm = useForm({
    defaultValues: { ...loadFiltersFromStorage(projectId), topics: "" },
  });

  const values = useStore(filtersForm.store, (s) => s.values);

  useEffect(() => {
    saveFiltersToStorage(projectId, {
      ...values,
      topics: readLegacyTopics(projectId),
    });
  }, [projectId, values]);

  const resetFilters = useCallback(() => {
    const keys: Array<keyof KeywordFilterValues> = [
      "include",
      "exclude",
      "minVol",
      "maxVol",
      "minCpc",
      "maxCpc",
      "minKd",
      "maxKd",
      "intents",
      "topics",
    ];

    for (const key of keys) {
      filtersForm.setFieldValue(key, "");
    }
  }, [filtersForm]);

  return {
    filtersForm,
    values,
    resetFilters,
  };
}
