import { lowercaseKeyword } from "@/shared/text-match";
import {
  createDataforseoClient,
  fetchKeywordMetricsForList,
} from "@/server/lib/dataforseo";
import {
  getKeywordDataCountryCode,
  resolveKeywordDataLanguage,
} from "@/shared/keyword-locations";
import {
  legacyTurkicLowercase,
  withoutStrayDot,
  writtenBeforeLegacyCutoff,
} from "@/server/lib/legacy-keyword-text";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type { rankTrackingKeywords } from "@/db/schema";
import {
  customerHasPaidPlan,
  getPaidPlanId,
  type BillingCustomerContext,
} from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  BASE_KEYWORDS_PER_CONFIG,
  devicesCount,
  estimateRankCheckCredits,
  estimateScheduledRankCheckCredits,
  isScheduledRankTrackingInterval,
  keywordsPerConfigForPlan,
  MAX_KEYWORDS_PER_CONFIG,
} from "@/shared/rank-tracking";

/**
 * How many keywords the organization's plan lets one tracker hold, for a
 * tracker that would hold `keywordCount`. Every plan allows the base limit,
 * so a tracker within it skips the plan lookup and gets the base limit back.
 * Deployments without billing have no plans and get the highest limit.
 */
async function keywordLimit(organizationId: string, keywordCount: number) {
  if (keywordCount <= BASE_KEYWORDS_PER_CONFIG) return BASE_KEYWORDS_PER_CONFIG;
  if (!(await isHostedServerAuthMode())) return MAX_KEYWORDS_PER_CONFIG;
  return keywordsPerConfigForPlan(await getPaidPlanId(organizationId));
}

async function addKeywords(
  tracker: { configId: string; projectId: string; organizationId: string },
  keywords: string[],
  approval:
    | { kind: "direct_user_action" }
    | {
        kind: "credit_ceiling";
        maxEstimatedScheduledCheckCredits?: number;
      },
  // Keep the keyword exactly as typed instead of lowercasing it. "Nodex" and
  // "nodex" are then two separately tracked (and separately billed) keywords.
  matchCase = false,
) {
  const { configId, projectId, organizationId } = tracker;
  const config = await getValidatedConfig(configId, projectId);
  const existing = await RankTrackingRepository.getKeywordsForConfig(configId);

  const existingKeywords = new Set(existing.map((kw) => kw.keyword));
  // Rows from the older plain toLowerCase(): "i\u0307stanbul" (from
  // "İstanbul") is "istanbul", and in Turkish a row written before the
  // cutoff as "isparta" is what "Isparta" (now "ısparta") stored.
  for (const kw of existing) {
    if (!kw.matchCase) existingKeywords.add(withoutStrayDot(kw.keyword));
  }
  const rowByText = new Map(existing.map((kw) => [kw.keyword, kw]));
  const normalize = (raw: string) =>
    matchCase ? raw.trim() : lowercaseKeyword(raw.trim(), config.languageCode);
  // "kir" asked for next to "KIR" is its own keyword, never the old twin.
  const requested = new Set(keywords.map(normalize));
  const seen = new Set<string>();
  const newRows: (typeof rankTrackingKeywords.$inferInsert)[] = [];

  for (const raw of keywords) {
    const normalized = normalize(raw);
    const legacy = matchCase
      ? null
      : legacyTurkicLowercase(raw, config.languageCode);
    const legacyRow =
      legacy && !requested.has(legacy) ? rowByText.get(legacy) : undefined;
    if (
      normalized &&
      !seen.has(normalized) &&
      !existingKeywords.has(normalized) &&
      !(
        legacyRow &&
        !legacyRow.matchCase &&
        writtenBeforeLegacyCutoff(legacyRow.createdAt)
      )
    ) {
      seen.add(normalized);
      newRows.push({
        id: crypto.randomUUID(),
        configId,
        keyword: normalized,
        matchCase,
      });
    }
  }

  // A tracker already over its limit (after a downgrade) keeps its keywords
  // and its checks; it only takes no new ones.
  const limit = await keywordLimit(
    organizationId,
    existing.length + newRows.length,
  );
  const rows = newRows.slice(0, Math.max(0, limit - existing.length));
  const overLimit =
    rows.length < newRows.length
      ? { limit, notAdded: newRows.length - rows.length }
      : undefined;

  const scheduleInterval = isScheduledRankTrackingInterval(
    config.scheduleInterval,
  )
    ? config.scheduleInterval
    : null;
  let scheduledEstimate:
    | ReturnType<typeof estimateScheduledRankCheckCredits>
    | undefined;
  if (rows.length > 0 && scheduleInterval) {
    scheduledEstimate = estimateScheduledRankCheckCredits(
      [...existing, ...rows].map((kw) => kw.keyword),
      config.devices,
      config.serpDepth,
      scheduleInterval,
    );
    if (
      approval.kind === "credit_ceiling" &&
      (approval.maxEstimatedScheduledCheckCredits == null ||
        scheduledEstimate.costCredits >
          approval.maxEstimatedScheduledCheckCredits)
    ) {
      throw scheduledApprovalError(scheduleInterval, scheduledEstimate);
    }
  }

  const addedIds =
    rows.length > 0
      ? await RankTrackingRepository.addKeywordsToConfig(rows)
      : [];

  if (
    scheduledEstimate &&
    scheduleInterval &&
    addedIds.length > 0 &&
    approval.kind === "credit_ceiling"
  ) {
    const persisted =
      await RankTrackingRepository.getKeywordsForConfig(configId);
    scheduledEstimate = estimateScheduledRankCheckCredits(
      persisted.map((kw) => kw.keyword),
      config.devices,
      config.serpDepth,
      scheduleInterval,
    );
    if (
      approval.maxEstimatedScheduledCheckCredits == null ||
      scheduledEstimate.costCredits > approval.maxEstimatedScheduledCheckCredits
    ) {
      await RankTrackingRepository.removeKeywordsFromConfig(addedIds, configId);
      throw scheduledApprovalError(scheduleInterval, scheduledEstimate);
    }
  }

  return { added: addedIds.length, addedIds, scheduledEstimate, overLimit };
}

/** Volume, difficulty and CPC for every keyword in a tracker. */
async function refreshMetrics(
  configId: string,
  projectId: string,
  billingCustomer: BillingCustomerContext,
): Promise<{ updated: number }> {
  await requireRankCheckAccess(billingCustomer.organizationId);
  const config = await getValidatedConfig(configId, projectId);
  const keywords = await RankTrackingRepository.getKeywordsForConfig(configId);
  if (keywords.length === 0) return { updated: 0 };

  const countryCode = getKeywordDataCountryCode(config);
  const client = createDataforseoClient(billingCustomer);
  // Also drops the stray dot older rows ("i\u0307stanbul") and match-case
  // "İstanbul" on a non-Turkish tracker would otherwise carry.
  const lower = (text: string) => lowercaseKeyword(text, config.languageCode);
  const metrics = await fetchKeywordMetricsForList(client, {
    // The keyword-data APIs are case-insensitive and echo keywords back
    // lowercased, so ask in lowercase. A match-case keyword can sit next to
    // its lowercase twin; both then map to the same metrics row and the
    // request carries no duplicates.
    keywords: [...new Set(keywords.map((kw) => lower(kw.keyword)))],
    locationCode: countryCode,
    // Trackers can pair any SERP language with any country; the keyword-data
    // APIs only serve the country's own languages.
    languageCode: resolveKeywordDataLanguage(countryCode, config.languageCode),
    // Local configs get volume/CPC scoped to the tracked city; national
    // numbers can overstate local demand by orders of magnitude.
    locationName: config.locationName ?? undefined,
    creditFeature: "rank_tracking",
  });
  const byKeyword = new Map(
    metrics.map((metric) => [lower(metric.keyword), metric]),
  );

  const now = new Date().toISOString();
  const updates = keywords
    .map((kw) => {
      const metric = byKeyword.get(lower(kw.keyword));
      if (!metric) return null;
      // Rank tracking only tracks volume / difficulty / CPC.
      return {
        id: kw.id,
        searchVolume: metric.searchVolume,
        keywordDifficulty: metric.keywordDifficulty,
        cpc: metric.cpc,
        metricsFetchedAt: now,
      };
    })
    .filter((u): u is NonNullable<typeof u> => u !== null);

  if (updates.length === 0) return { updated: 0 };
  await RankTrackingRepository.updateKeywordMetrics(updates);
  return { updated: updates.length };
}

/** Paid hosted plans only; self-hosters always can. */
export async function requireRankCheckAccess(organizationId: string) {
  if (!(await isHostedServerAuthMode())) return;
  if (await customerHasPaidPlan(organizationId)) return;
  throw new AppError(
    "PAYMENT_REQUIRED",
    "Upgrade to the paid plan to run rank checks",
  );
}

async function removeKeywords(
  configId: string,
  projectId: string,
  keywordIds: string[],
) {
  await getValidatedConfig(configId, projectId);
  const uniqueIds = [...new Set(keywordIds)];
  const removedIds = await RankTrackingRepository.removeKeywordsFromConfig(
    uniqueIds,
    configId,
  );
  return { removed: removedIds.length, removedIds };
}

async function setKeywordsPinned(
  configId: string,
  projectId: string,
  keywordIds: string[],
  pinned: boolean,
) {
  await getValidatedConfig(configId, projectId);
  const updatedIds = await RankTrackingRepository.setKeywordsPinned(
    [...new Set(keywordIds)],
    configId,
    pinned,
  );
  return { updated: updatedIds.length, updatedIds };
}

async function estimateCost(
  configId: string,
  projectId: string,
  organizationId: string,
  additionalKeywords: readonly string[] = [],
) {
  const config = await getValidatedConfig(configId, projectId);
  const existing = await RankTrackingRepository.getKeywordsForConfig(configId);
  const existingKeywordCount = existing.length;
  const limit = await keywordLimit(
    organizationId,
    existingKeywordCount + additionalKeywords.length,
  );
  const keywords = [
    ...existing.map((kw) => kw.keyword),
    ...additionalKeywords,
  ].slice(0, Math.max(existingKeywordCount, limit));
  const keywordCount = keywords.length;
  const { costUsd, costCredits } = estimateRankCheckCredits(
    keywords,
    config.devices,
    config.serpDepth,
  );
  const scheduleInterval = isScheduledRankTrackingInterval(
    config.scheduleInterval,
  )
    ? config.scheduleInterval
    : null;
  return {
    costUsd,
    costCredits,
    keywordCount,
    devicesCount: devicesCount(config.devices),
    totalChecks: keywordCount * devicesCount(config.devices),
    existingKeywordCount,
    additionalKeywordCount: keywordCount - existingKeywordCount,
    scheduledEstimate: scheduleInterval
      ? estimateScheduledRankCheckCredits(
          keywords,
          config.devices,
          config.serpDepth,
          scheduleInterval,
        )
      : undefined,
  };
}

async function getValidatedConfig(configId: string, projectId: string) {
  const config = await RankTrackingRepository.getConfigById({
    configId,
    projectId,
  });
  if (!config) {
    throw new AppError("NOT_FOUND", "Rank tracking config not found");
  }
  return config;
}

function scheduledApprovalError(
  scheduleInterval: "daily" | "weekly" | "monthly",
  estimate: ReturnType<typeof estimateScheduledRankCheckCredits>,
) {
  return new AppError(
    "VALIDATION_ERROR",
    `Adding these keywords would make each ${scheduleInterval} scheduled check cost up to ${estimate.costCredits} credits including retries (~$${estimate.costUsd.toFixed(4)} per check; up to ~${estimate.monthlyCostCredits} credits/month). Call estimate_rank_tracker_cost with additionalKeywords, show the recurring estimate to the user, then retry with maxEstimatedScheduledCheckCredits set to the approved per-check estimate.`,
  );
}

export const RankTrackingKeywordService = {
  addKeywords,
  removeKeywords,
  setKeywordsPinned,
  estimateCost,
  refreshMetrics,
};
