import { z } from "zod";
import {
  KEYWORD_GAP_MAX_COMPETITOR_ROWS,
  KeywordGapService,
} from "@/server/features/keyword-gap/services/KeywordGapService";
import { GSC_DATE_RANGES } from "@/server/features/gsc/searchAnalytics";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import {
  formatMcpTable,
  positionCell,
  truncatedCell,
  type McpTableColumn,
} from "@/server/mcp/table";
import {
  describeGscError,
  missingSelfHostedGoogleClientResponse,
} from "@/server/mcp/tools/search-console-tools";
import { buildConnectGscUrl } from "@/server/mcp/urls";
import { keywordGapSchema, type KeywordGapData } from "@/shared/mcp-contracts";

const inputSchema = {
  projectId: projectIdSchema,
  competitorDomain: z
    .string()
    .min(1)
    .max(255)
    .describe(
      "Competitor domain, e.g. example.com; a protocol and www are ignored, a path is rejected. Its subdomains are included.",
    ),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  maxRank: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Only competitor keywords ranking at this position or better. Defaults to 30.",
    ),
  positionThreshold: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "A keyword the site already has impressions for is a gap when its average Search Console position is worse than this. Defaults to 20.",
    ),
  dateRange: z
    .enum(GSC_DATE_RANGES)
    .optional()
    .describe("Search Console window. Defaults to last_3_months."),
  competitorLimit: z
    .number()
    .int()
    .min(1)
    .max(KEYWORD_GAP_MAX_COMPETITOR_ROWS)
    .optional()
    .describe(
      "Competitor keywords to read from DataForSEO Labs, highest volume first (1-1000). Defaults to 1000; each row adds to the cost.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Gap rows to return, highest volume first. Defaults to 100."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type GapRow = KeywordGapData["keywords"][number];

const GAP_COLUMNS: McpTableColumn<GapRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "volume", value: (row) => row.searchVolume },
  { header: "their rank", value: (row) => row.competitorRank },
  {
    header: "our position",
    value: (row) => row.ourPosition,
    format: positionCell,
  },
  { header: "our impressions", value: (row) => row.ourImpressions },
  { header: "our clicks", value: (row) => row.ourClicks },
  { header: "intent", value: (row) => row.intent },
  {
    header: "their url",
    value: (row) => row.competitorUrl,
    format: truncatedCell(120),
  },
];

export const getKeywordGapTool = {
  name: "get_keyword_gap",
  config: {
    title: "Get keyword gap",
    description:
      "Find keywords a competitor ranks for where the project's site is missing or weak: the competitor's organic keywords from DataForSEO Labs (rank maxRank or better, default 30), compared with the project's Search Console queries (default last 3 months). A keyword is a gap when the site has no Search Console impressions for it or its average position is worse than positionThreshold (default 20). Matching is exact phrase after case folding (Turkish i/İ/ı/I are one letter) and whitespace normalization; no fuzzy matching. Each row has volume, the competitor's rank and URL, intent, and the site's impressions, clicks, and position (null if none), sorted by volume. counts splits the compared keywords into three disjoint groups that add up to competitorTotal: ranking (position at positionThreshold or better), belowThreshold (impressions, but a worse position) and noImpressions; gap = noImpressions + belowThreshold. competitorKeywordsWithinMaxRank is how many keywords Labs has for the competitor at maxRank or better, of which competitorLimit are read. Labs covers non-English long-tail queries thinly and Search Console hides rare queries, so treat the result as a topic map, not a complete list. Search Console is not filtered by country, while the competitor's keywords are for one country (the project's market unless locationCode is set). Requires a connected Search Console property, which is read first so an unconnected project spends nothing. Costs ~15-170 credits (one Labs call billed per returned row, up to 1,000), well under the 2,000-credit confirmation threshold; cached for 12 hours. For the competitor's full keyword list, use get_ranked_keywords.",
    inputSchema,
    outputSchema: keywordGapSchema.partial().extend({
      ok: z.boolean(),
      reason: z.string().optional(),
      connectionRequired: z.boolean().optional(),
      connectUrl: z.string().optional(),
      setupDocsUrl: z.string().optional(),
      connected: z.boolean().optional(),
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const blocked = await missingSelfHostedGoogleClientResponse(
      context,
      args.projectId,
    );
    if (blocked) return blocked;

    const metaFor = (domain?: string) =>
      buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        domain ? { domain } : undefined,
      );
    const connectUrl = buildConnectGscUrl(
      context.baseUrl,
      args.projectId,
      Boolean(context.auth.guestClaimToken),
    );

    let result: KeywordGapData;
    try {
      result = await KeywordGapService.getKeywordGap(
        {
          projectId: args.projectId,
          project: context.project,
          competitorDomain: args.competitorDomain,
          locationCode: args.locationCode,
          languageCode: args.languageCode,
          maxRank: args.maxRank ?? 30,
          positionThreshold: args.positionThreshold ?? 20,
          dateRange: args.dateRange ?? "last_3_months",
          competitorLimit:
            args.competitorLimit ?? KEYWORD_GAP_MAX_COMPETITOR_ROWS,
          limit: args.limit ?? 100,
        },
        context.billing,
      );
    } catch (error) {
      const isGscError =
        error instanceof GscNotConnectedError ||
        error instanceof GscTokenError ||
        error instanceof GscApiError;
      if (!isGscError) throw error;
      const isNotConnected = error instanceof GscNotConnectedError;
      const isTokenError = error instanceof GscTokenError;
      const link = isNotConnected
        ? ` Connect it here: ${connectUrl}`
        : isTokenError
          ? ` Reconnect it here: ${connectUrl}`
          : "";
      return mcpResponse({
        text: `${describeGscError(error)} The keyword gap compares against Search Console, so nothing was charged.${link}`,
        meta: metaFor(),
        structuredContent: {
          ok: false,
          reason: isNotConnected ? "not_connected" : "api_error",
          connectionRequired: isNotConnected || isTokenError,
          connectUrl,
        },
      });
    }

    const { counts } = result;
    const inLabs =
      counts.competitorKeywordsWithinMaxRank != null &&
      counts.competitorKeywordsWithinMaxRank > counts.competitorTotal
        ? ` (read ${counts.competitorTotal} of the ${counts.competitorKeywordsWithinMaxRank} Labs has at that rank)`
        : "";
    const shown =
      counts.returned < counts.gap
        ? `, showing top ${counts.returned} by volume`
        : "";
    const truncated = result.searchConsoleTruncated
      ? ` Search Console reached the 100,000-row limit (${result.searchConsoleQueries} distinct queries read); queries past it were not compared, so some "no impressions" rows may be wrong.`
      : "";
    const header =
      `${result.competitor} vs ${result.siteUrl} · Search Console ${result.startDate}→${result.endDate} · ` +
      `competitor keywords at rank ≤${result.maxRank} compared: ${counts.competitorTotal}${inLabs} · ` +
      `we rank at position ≤${result.positionThreshold}: ${counts.ranking} · ` +
      `we have impressions but rank worse than ${result.positionThreshold}: ${counts.belowThreshold} · ` +
      `no impressions: ${counts.noImpressions} · ` +
      `gap (no impressions + worse than ${result.positionThreshold}): ${counts.gap}${shown}.${truncated}`;
    const text =
      result.keywords.length > 0
        ? `${header}\n${formatMcpTable(result.keywords, GAP_COLUMNS)}`
        : `${header}\nNo gap keywords.`;
    return mcpResponse({
      text,
      meta: metaFor(result.competitor),
      structuredContent: { ok: true, ...result },
    });
  }),
};
