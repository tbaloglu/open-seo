import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { keywordMetrics } from "@/db/schema";

// D1 caps bound parameters at 100 per statement; leave headroom for the
// project and market filters.
const QUERY_CHUNK_SIZE = 80;

/** Stored metrics for these keyword texts in one project market. */
async function listKeywordMetrics(params: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
}) {
  const keywords = [...new Set(params.keywords)];
  const rows: (typeof keywordMetrics.$inferSelect)[] = [];
  for (let i = 0; i < keywords.length; i += QUERY_CHUNK_SIZE) {
    rows.push(
      ...(await db
        .select()
        .from(keywordMetrics)
        .where(
          and(
            eq(keywordMetrics.projectId, params.projectId),
            eq(keywordMetrics.locationCode, params.locationCode),
            eq(keywordMetrics.languageCode, params.languageCode),
            inArray(
              keywordMetrics.keyword,
              keywords.slice(i, i + QUERY_CHUNK_SIZE),
            ),
          ),
        )),
    );
  }
  return rows;
}

export const KeywordMetricsQueries = { listKeywordMetrics } as const;
