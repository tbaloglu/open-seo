import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import { SerpHistoryRepository } from "../repositories/SerpHistoryRepository";
import { getChanges } from "./serpChanges";
import {
  getCompetitors,
  getQuestionsAndSources,
  listRuns,
} from "./serpTrackerViews";
import {
  getValidatedConfig,
  indexPages,
  pageKey,
  resolveDevice,
  type Device,
  type SavedPage,
} from "./serpHistoryShared";

async function findKeywordTracker(input: {
  projectId: string;
  trackerId?: string;
  // The keyword's text, or its id (which wins) when the caller has it.
  keyword?: string;
  trackingKeywordId?: string;
}) {
  const configs = input.trackerId
    ? [await getValidatedConfig(input.trackerId, input.projectId)]
    : await RankTrackingRepository.getConfigsForProject(input.projectId);
  const matches = (
    await Promise.all(
      configs.map(async (config) => {
        const keywords = await RankTrackingRepository.getKeywordsForConfig(
          config.id,
        );
        // In the tracker's language, so "TURŞU" finds "turşu" in Turkish.
        const lower = (text: string) =>
          text.trim().toLocaleLowerCase(config.languageCode);
        const wanted = lower(input.keyword ?? "");
        // By id when known: a match-case tracker can track "Turşu" and "turşu".
        const keyword = keywords.find((row) =>
          input.trackingKeywordId
            ? row.id === input.trackingKeywordId
            : lower(row.keyword) === wanted,
        );
        return keyword ? [{ config, keyword }] : [];
      }),
    )
  ).flat();
  if (matches.length === 0) {
    throw new AppError(
      "NOT_FOUND",
      "No rank tracker in this project tracks that keyword.",
    );
  }
  if (matches.length > 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      `More than one tracker tracks that keyword; pass trackerId (${matches.map((match) => match.config.id).join(", ")}).`,
    );
  }
  return matches[0];
}

type FeatureValue = { value: string | null; domain: string | null };

function pageOf(page: SavedPage | undefined) {
  const features = new Map<string, FeatureValue[]>();
  for (const row of page?.features ?? []) {
    const values = features.get(row.featureType) ?? [];
    values.push({ value: row.value, domain: row.domain });
    features.set(row.featureType, values);
  }
  return {
    saved: page !== undefined,
    top10: (page?.results ?? []).map(({ rank, domain, url, title }) => ({
      rank,
      domain,
      url,
      title,
    })),
    features: [...features].map(([type, values]) => ({
      type,
      values: values.filter((entry) => entry.value !== null),
    })),
  };
}

/** One keyword's latest checks: our position and the page each check read. */
async function getKeywordHistory(input: {
  projectId: string;
  projectDefaultDevice: Device;
  trackerId?: string;
  keyword?: string;
  trackingKeywordId?: string;
  device?: Device;
  runs: number;
}) {
  const { config, keyword } = await findKeywordTracker(input);
  const device = resolveDevice(
    config,
    input.device,
    input.projectDefaultDevice,
  );
  const checks = await SerpHistoryRepository.getKeywordChecks({
    configId: config.id,
    trackingKeywordId: keyword.id,
    device,
    limit: input.runs,
  });
  const pages = indexPages(
    await SerpHistoryRepository.getPages({
      runIds: checks.map((check) => check.runId),
      device,
      trackingKeywordId: keyword.id,
    }),
  );
  return {
    config,
    keyword,
    device,
    checks: checks.map((check) => ({
      runId: check.runId,
      checkedAt: check.startedAt,
      position: check.position,
      ...pageOf(pages.get(pageKey(check.runId, keyword.id))),
    })),
  };
}

export const SerpHistoryService = {
  getKeywordHistory,
  getChanges,
  listRuns,
  getCompetitors,
  getQuestionsAndSources,
};
