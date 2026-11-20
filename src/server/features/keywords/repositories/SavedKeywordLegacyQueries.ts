import { and, asc, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { keywordMetrics, savedKeywords } from "@/db/schema";

/**
 * A project market's saved keywords holding a combining dot (U+0307), which
 * plain toLowerCase() left after "i" for "İ". Oldest first.
 */
async function listSavedKeywordsWithStrayDot(params: {
  projectId: string;
  locationCode: number;
  languageCode: string;
}) {
  return db
    .select({ keyword: savedKeywords.keyword })
    .from(savedKeywords)
    .where(
      and(
        eq(savedKeywords.projectId, params.projectId),
        eq(savedKeywords.locationCode, params.locationCode),
        eq(savedKeywords.languageCode, params.languageCode),
        like(savedKeywords.keyword, "%\u0307%"),
      ),
    )
    .orderBy(asc(savedKeywords.createdAt), asc(savedKeywords.keyword));
}

async function getKeywordMetric(params: {
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
}) {
  const [metric] = await db
    .select()
    .from(keywordMetrics)
    .where(
      and(
        eq(keywordMetrics.projectId, params.projectId),
        eq(keywordMetrics.keyword, params.keyword),
        eq(keywordMetrics.locationCode, params.locationCode),
        eq(keywordMetrics.languageCode, params.languageCode),
      ),
    )
    .limit(1);
  return metric ?? null;
}

export const SavedKeywordLegacyQueries = {
  listSavedKeywordsWithStrayDot,
  getKeywordMetric,
} as const;
