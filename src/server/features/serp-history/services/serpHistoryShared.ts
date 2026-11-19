import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import type { SerpHistoryRepository } from "../repositories/SerpHistoryRepository";

export type Device = "desktop" | "mobile";
type Pages = Awaited<ReturnType<typeof SerpHistoryRepository.getPages>>;
export type SavedPage = {
  results: Pages["results"];
  features: Pages["features"];
};

/** Whether the tracked domain (or a subdomain of it) is this site. */
export function isOwnSite(site: string | null, domain: string) {
  return site !== null && (site === domain || site.endsWith(`.${domain}`));
}

export const pageKey = (runId: string, trackingKeywordId: string) =>
  `${runId}:${trackingKeywordId}`;

/** Saved rows grouped by run and keyword, read once. */
export function indexPages(pages: Pages) {
  const index = new Map<string, SavedPage>();
  const pageFor = (row: { runId: string; trackingKeywordId: string }) => {
    const key = pageKey(row.runId, row.trackingKeywordId);
    const page = index.get(key) ?? { results: [], features: [] };
    index.set(key, page);
    return page;
  };
  for (const row of pages.results) pageFor(row).results.push(row);
  for (const row of pages.features) pageFor(row).features.push(row);
  return index;
}

/**
 * The device to read: the one asked for, else the tracker's only device, else
 * the project's default device.
 */
export function resolveDevice(
  config: RankTrackingConfig,
  requested: Device | undefined,
  projectDefault: Device,
): Device {
  const device =
    requested ?? (config.devices === "both" ? projectDefault : config.devices);
  if (config.devices !== "both" && config.devices !== device) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This tracker only checks ${config.devices}.`,
    );
  }
  return device;
}

export async function getValidatedConfig(configId: string, projectId: string) {
  const config = await RankTrackingRepository.getConfigById({
    configId,
    projectId,
  });
  if (!config) {
    throw new AppError("NOT_FOUND", "Rank tracker not found");
  }
  return config;
}

/** A tracker that tracks the keyword: the given one, or the only match. */
