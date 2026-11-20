import { waitUntil } from "cloudflare:workers";
import { sortBy } from "remeda";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  createDataforseoClient,
  type DomainRankedKeywordItem,
} from "@/server/lib/dataforseo";
import { buildRankedKeywordsScopeFilter } from "@/server/lib/dataforseo/researchScopeFilters";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { GscService } from "@/server/features/gsc/services/GscService";
import type { GscDateRange } from "@/server/features/gsc/searchAnalytics";
import { resolveLabsMarket } from "@/shared/keyword-locations";
import { foldedTermKey } from "@/shared/text-match";
import type { KeywordGapData } from "@/shared/mcp-contracts";

// Google's searchAnalytics page size. Four pages bound a Worker's memory; a
// property with more distinct queries than that is reported as truncated.
const GSC_PAGE_SIZE = 25_000;
const GSC_MAX_PAGES = 4;
// One Labs call returns at most 1,000 rows.
export const KEYWORD_GAP_MAX_COMPETITOR_ROWS = 1_000;
const COMPETITOR_CACHE_TTL_SECONDS = 12 * 60 * 60;

const competitorKeywordSchema = z.object({
  keyword: z.string(),
  searchVolume: z.number().nullable(),
  rank: z.number().nullable(),
  url: z.string().nullable(),
  intent: z.string().nullable(),
});
const competitorPageSchema = z.object({
  keywords: z.array(competitorKeywordSchema),
  totalCount: z.number().nullable(),
});
type CompetitorPage = z.infer<typeof competitorPageSchema>;

const intentSchema = z.object({
  search_intent_info: z.object({ main_intent: z.string().nullish() }).nullish(),
});

function toCompetitorKeyword(item: DomainRankedKeywordItem) {
  const keyword = item.keyword_data?.keyword ?? item.keyword;
  if (!keyword) return null;
  const serpItem = item.ranked_serp_element?.serp_item;
  const volume = item.keyword_data?.keyword_info?.search_volume;
  const rank =
    serpItem?.rank_absolute ?? item.ranked_serp_element?.rank_absolute;
  const intent = intentSchema.safeParse(item.keyword_data ?? {});
  return {
    keyword,
    searchVolume: volume != null ? Math.round(volume) : null,
    rank: rank != null ? Math.round(rank) : null,
    url: serpItem?.url ?? item.ranked_serp_element?.url ?? null,
    intent: intent.success
      ? (intent.data.search_intent_info?.main_intent ?? null)
      : null,
  };
}

/** The competitor's organic keywords at maxRank or better, by volume. Billed
 *  and metered like get_ranked_keywords, and cached per project for 12 hours. */
async function fetchCompetitorKeywords(
  input: {
    projectId: string;
    domain: string;
    locationCode: number;
    languageCode: string;
    maxRank: number;
    limit: number;
  },
  billingCustomer: BillingCustomerContext,
): Promise<{ target: string; page: CompetitorPage }> {
  const target = parseResearchTargetOrThrow(input.domain);
  const scopeFilter = buildRankedKeywordsScopeFilter(target);
  const cacheKey = await buildCacheKey("keyword-gap:competitor", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: target.hostname,
    scope: target.scope,
    path: target.path,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    maxRank: input.maxRank,
    limit: input.limit,
  });
  const cached = competitorPageSchema.safeParse(await getCached(cacheKey));
  if (cached.success) return { target: target.display, page: cached.data };

  const filters: unknown[] = [];
  for (const clause of scopeFilter.clauses) {
    if (filters.length > 0) filters.push("and");
    filters.push(clause);
  }
  if (filters.length > 0) filters.push("and");
  filters.push([
    "ranked_serp_element.serp_item.rank_absolute",
    "<=",
    input.maxRank,
  ]);

  const response = await createDataforseoClient(
    billingCustomer,
  ).domain.rankedKeywords({
    target: target.hostname,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: input.limit,
    orderBy: ["keyword_data.keyword_info.search_volume,desc"],
    filters,
    itemTypes: ["organic"],
  });
  const page: CompetitorPage = {
    keywords: response.items
      .map(toCompetitorKeyword)
      .filter((row) => row != null),
    totalCount: response.totalCount,
  };
  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(cacheKey, page, COMPETITOR_CACHE_TTL_SECONDS).catch((error) => {
      console.error("keyword-gap.competitor.cache-write failed:", error);
    }),
  );
  return { target: target.display, page };
}

type OurQuery = { impressions: number; clicks: number; positionSum: number };

/** Every Search Console query of the window, folded so "İzmir" and "izmir"
 *  are one query; position is impression-weighted across folded variants. */
async function fetchOurQueries(projectId: string, dateRange: GscDateRange) {
  const queries = new Map<string, OurQuery>();
  let siteUrl = "";
  let startDate = "";
  let endDate = "";
  let truncated = false;
  for (let page = 0; page < GSC_MAX_PAGES; page++) {
    const result = await GscService.getPerformance({
      projectId,
      dimensions: ["query"],
      dateRange,
      rowLimit: GSC_PAGE_SIZE,
      startRow: page * GSC_PAGE_SIZE,
      type: "web",
    });
    siteUrl = result.siteUrl;
    startDate = result.request.startDate;
    endDate = result.request.endDate;
    for (const row of result.rows) {
      const query = row.keys?.[0];
      if (!query) continue;
      const key = foldedTermKey(query);
      const entry = queries.get(key) ?? {
        impressions: 0,
        clicks: 0,
        positionSum: 0,
      };
      entry.impressions += row.impressions;
      entry.clicks += row.clicks;
      entry.positionSum += row.position * row.impressions;
      queries.set(key, entry);
    }
    if (result.rows.length < GSC_PAGE_SIZE) break;
    truncated = page === GSC_MAX_PAGES - 1;
  }
  return { queries, siteUrl, startDate, endDate, truncated };
}

/**
 * Keywords a competitor ranks for where the project's site is absent from
 * Search Console or ranks worse than positionThreshold. Reads Search Console
 * first, so an unconnected project fails before any credits are spent.
 */
async function getKeywordGap(
  input: {
    projectId: string;
    project: { locationCode: number; languageCode: string };
    competitorDomain: string;
    locationCode?: number;
    languageCode?: string;
    maxRank: number;
    positionThreshold: number;
    dateRange: GscDateRange;
    competitorLimit: number;
    limit: number;
  },
  billingCustomer: BillingCustomerContext,
): Promise<KeywordGapData> {
  const market = resolveLabsMarket(
    { locationCode: input.locationCode, languageCode: input.languageCode },
    input.project,
  );
  assertLabsLocationCode(market.locationCode);
  assertLanguageForLocation(market.locationCode, market.languageCode);

  const ours = await fetchOurQueries(input.projectId, input.dateRange);
  const competitor = await fetchCompetitorKeywords(
    {
      projectId: input.projectId,
      domain: input.competitorDomain,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      maxRank: input.maxRank,
      limit: input.competitorLimit,
    },
    billingCustomer,
  );

  let matched = 0;
  const gap: KeywordGapData["keywords"] = [];
  const seen = new Set<string>();
  for (const row of competitor.page.keywords) {
    const key = foldedTermKey(row.keyword);
    if (seen.has(key)) continue;
    seen.add(key);
    const our = ours.queries.get(key);
    const ourPosition =
      our && our.impressions > 0
        ? Math.round((our.positionSum / our.impressions) * 10) / 10
        : null;
    if (ourPosition != null) matched++;
    if (ourPosition != null && ourPosition <= input.positionThreshold) continue;
    gap.push({
      keyword: row.keyword,
      searchVolume: row.searchVolume,
      competitorRank: row.rank,
      competitorUrl: row.url,
      intent: row.intent,
      ourImpressions: ourPosition != null ? (our?.impressions ?? null) : null,
      ourClicks: ourPosition != null ? (our?.clicks ?? null) : null,
      ourPosition,
    });
  }
  const sorted = sortBy(gap, [(row) => row.searchVolume ?? -1, "desc"]);

  return {
    competitor: competitor.target,
    siteUrl: ours.siteUrl,
    startDate: ours.startDate,
    endDate: ours.endDate,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    maxRank: input.maxRank,
    positionThreshold: input.positionThreshold,
    counts: {
      competitorTotal: seen.size,
      competitorTotalInLabs: competitor.page.totalCount,
      matched,
      gap: sorted.length,
      returned: Math.min(sorted.length, input.limit),
    },
    searchConsoleQueries: ours.queries.size,
    searchConsoleTruncated: ours.truncated,
    keywords: sorted.slice(0, input.limit),
  };
}

export const KeywordGapService = { getKeywordGap } as const;
