import { createServerFn } from "@tanstack/react-start";
import {
  GscNotConnectedError,
  isExpectedGrantFailure,
} from "@/server/features/gsc/services/GscService";
import {
  KEYWORD_GAP_MAX_COMPETITOR_ROWS,
  KeywordGapService,
} from "@/server/features/keyword-gap/services/KeywordGapService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { keywordGapInputSchema } from "@/types/schemas/keyword-gap";

/**
 * The get_keyword_gap tool's comparison with its defaults. Search Console is
 * read first, so a project without it gets the connect card and spends nothing.
 */
export const getKeywordGap = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(keywordGapInputSchema)
  .handler(async ({ data, context }) => {
    try {
      const result = await KeywordGapService.getKeywordGap(
        {
          projectId: context.projectId,
          project: context.project,
          competitorDomain: data.competitorDomain,
          locationCode: data.locationCode,
          maxRank: 30,
          positionThreshold: 20,
          dateRange: "last_3_months",
          competitorLimit: KEYWORD_GAP_MAX_COMPETITOR_ROWS,
          limit: 500,
        },
        context,
      );
      // The MCP contract's loose objects are not serializable as-is; pick
      // the fields the page shows.
      const { counts } = result;
      return {
        connected: true as const,
        competitor: result.competitor,
        siteUrl: result.siteUrl,
        startDate: result.startDate,
        endDate: result.endDate,
        locationCode: result.locationCode,
        languageCode: result.languageCode,
        maxRank: result.maxRank,
        positionThreshold: result.positionThreshold,
        searchConsoleTruncated: result.searchConsoleTruncated,
        counts: {
          competitorTotal: counts.competitorTotal,
          noImpressions: counts.noImpressions,
          belowThreshold: counts.belowThreshold,
          ranking: counts.ranking,
          gap: counts.gap,
          returned: counts.returned,
        },
        keywords: result.keywords.map((row) => ({
          keyword: row.keyword,
          searchVolume: row.searchVolume,
          competitorRank: row.competitorRank,
          competitorUrl: row.competitorUrl,
          ourImpressions: row.ourImpressions,
          ourPosition: row.ourPosition,
        })),
      };
    } catch (error) {
      if (
        error instanceof GscNotConnectedError ||
        isExpectedGrantFailure(error)
      ) {
        return { connected: false as const };
      }
      throw error;
    }
  });
