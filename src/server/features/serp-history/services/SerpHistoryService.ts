import { sortBy } from "remeda";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { SerpHistoryRepository } from "../repositories/SerpHistoryRepository";

type Device = "desktop" | "mobile";
type Pages = Awaited<ReturnType<typeof SerpHistoryRepository.getPages>>;

/** Whether the tracked domain (or a subdomain of it) is this site. */
function isOwnSite(site: string | null, domain: string) {
  return site !== null && (site === domain || site.endsWith(`.${domain}`));
}

/**
 * The device to read: the one asked for, else the tracker's only device, else
 * the project's default device.
 */
function resolveDevice(
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

async function getValidatedConfig(configId: string, projectId: string) {
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
async function findKeywordTracker(input: {
  projectId: string;
  trackerId?: string;
  keyword: string;
}) {
  const configs = input.trackerId
    ? [await getValidatedConfig(input.trackerId, input.projectId)]
    : await RankTrackingRepository.getConfigsForProject(input.projectId);
  const typed = input.keyword.trim();
  const matches = (
    await Promise.all(
      configs.map(async (config) => {
        const keywords = await RankTrackingRepository.getKeywordsForConfig(
          config.id,
        );
        const lowered = typed.toLocaleLowerCase(config.languageCode);
        const keyword = keywords.find(
          (row) => row.keyword === typed || row.keyword === lowered,
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

function pageOf(pages: Pages, runId: string, trackingKeywordId: string) {
  const top10 = pages.results
    .filter(
      (row) =>
        row.runId === runId && row.trackingKeywordId === trackingKeywordId,
    )
    .map(({ rank, domain, url, title }) => ({ rank, domain, url, title }));
  const features = new Map<string, FeatureValue[]>();
  for (const row of pages.features) {
    if (row.runId !== runId || row.trackingKeywordId !== trackingKeywordId)
      continue;
    const values = features.get(row.featureType) ?? [];
    values.push({ value: row.value, domain: row.domain });
    features.set(row.featureType, values);
  }
  return {
    saved: top10.length > 0 || features.size > 0,
    top10,
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
  keyword: string;
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
  const pages = await SerpHistoryRepository.getPages({
    runIds: checks.map((check) => check.runId),
    device,
    trackingKeywordId: keyword.id,
  });
  return {
    config,
    keyword,
    device,
    checks: checks.map((check) => ({
      runId: check.runId,
      checkedAt: check.startedAt,
      position: check.position,
      ...pageOf(pages, check.runId, keyword.id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Changes between two checks
// ---------------------------------------------------------------------------

type AiOverview = "cited" | "not_cited" | "absent";

type PageState = {
  position: number | null;
  top10: Set<string>;
  questions: Set<string>;
  aiOverview: AiOverview;
  featureTypes: Set<string>;
};

type SetChange = { value: string; persisted: boolean };

/**
 * What was added and removed between `from` and `to`. These are single-check
 * changes (`persisted: false`): Google varies between reads, so one may be
 * noise. With a `previous` check, a change between it and `from` that `to`
 * still shows is added as `persisted: true`, since it held for two checks.
 */
function setChanges(
  previous: Set<string> | undefined,
  from: Set<string>,
  to: Set<string>,
) {
  const added: SetChange[] = [];
  const removed: SetChange[] = [];
  for (const value of to)
    if (!from.has(value)) added.push({ value, persisted: false });
  for (const value of from)
    if (!to.has(value)) removed.push({ value, persisted: false });
  if (previous) {
    for (const value of from)
      if (!previous.has(value) && to.has(value))
        added.push({ value, persisted: true });
    for (const value of previous)
      if (!from.has(value) && !to.has(value))
        removed.push({ value, persisted: true });
  }
  return { added, removed };
}

function pageState(
  pages: Pages,
  runId: string,
  trackingKeywordId: string,
  position: number | null,
  domain: string,
): PageState | null {
  const results = pages.results.filter(
    (row) => row.runId === runId && row.trackingKeywordId === trackingKeywordId,
  );
  const features = pages.features.filter(
    (row) => row.runId === runId && row.trackingKeywordId === trackingKeywordId,
  );
  if (results.length === 0 && features.length === 0) return null;
  const aiSources = features.filter((row) => row.featureType === "ai_overview");
  return {
    position,
    top10: new Set(
      results.flatMap((row) => (row.domain === null ? [] : [row.domain])),
    ),
    questions: new Set(
      features.flatMap((row) =>
        row.featureType === "people_also_ask" && row.value !== null
          ? [row.value]
          : [],
      ),
    ),
    aiOverview:
      aiSources.length === 0
        ? "absent"
        : aiSources.some((row) => isOwnSite(row.domain, domain))
          ? "cited"
          : "not_cited",
    featureTypes: new Set(features.map((row) => row.featureType)),
  };
}

function runsToCompare(
  runs: Array<{ id: string; startedAt: string }>,
  fromRunId: string | undefined,
  toRunId: string | undefined,
) {
  const indexOf = (runId: string) => {
    const index = runs.findIndex((run) => run.id === runId);
    if (index === -1) {
      throw new AppError(
        "NOT_FOUND",
        `Run ${runId} is not a completed full check of this tracker.`,
      );
    }
    return index;
  };
  // Newest first, so a higher index is an earlier check.
  const toIndex = toRunId ? indexOf(toRunId) : 0;
  const fromIndex = fromRunId ? indexOf(fromRunId) : toIndex + 1;
  if (fromIndex >= runs.length) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Comparing needs two completed checks of this tracker.",
    );
  }
  if (fromIndex <= toIndex) {
    throw new AppError(
      "VALIDATION_ERROR",
      "fromRunId must be an earlier check than toRunId.",
    );
  }
  return {
    to: runs[toIndex],
    from: runs[fromIndex],
    previous: runs[fromIndex + 1] as (typeof runs)[number] | undefined,
  };
}

/**
 * What changed on the tracker's SERPs between two completed full checks, by
 * default the latest two, with the check before `from` used to tell changes
 * that held from single-check ones.
 */
async function getChanges(input: {
  projectId: string;
  projectDefaultDevice: Device;
  trackerId: string;
  fromRunId?: string;
  toRunId?: string;
  device?: Device;
}) {
  const config = await getValidatedConfig(input.trackerId, input.projectId);
  const device = resolveDevice(
    config,
    input.device,
    input.projectDefaultDevice,
  );
  const runs = runsToCompare(
    await SerpHistoryRepository.getCompletedRuns(config.id),
    input.fromRunId,
    input.toRunId,
  );
  const runIds = [runs.previous, runs.from, runs.to].flatMap((run) =>
    run ? [run.id] : [],
  );
  const [snapshots, pages] = await Promise.all([
    SerpHistoryRepository.getSnapshots(runIds, device),
    SerpHistoryRepository.getPages({ runIds, device }),
  ]);
  const position = new Map(
    snapshots.map((row) => [
      `${row.runId}:${row.trackingKeywordId}`,
      row.position,
    ]),
  );
  const stateOf = (runId: string | undefined, trackingKeywordId: string) =>
    runId
      ? pageState(
          pages,
          runId,
          trackingKeywordId,
          position.get(`${runId}:${trackingKeywordId}`) ?? null,
          config.domain,
        )
      : null;

  const keywords = new Map(
    snapshots
      .filter((row) => row.runId === runs.to.id || row.runId === runs.from.id)
      .map((row) => [row.trackingKeywordId, row.keyword]),
  );
  const unsaved: string[] = [];
  const counts = new Map<
    string,
    { previous: number; from: number; to: number }
  >();
  const countDomains = (
    state: PageState | null,
    key: "previous" | "from" | "to",
  ) => {
    for (const domain of state?.top10 ?? []) {
      const count = counts.get(domain) ?? { previous: 0, from: 0, to: 0 };
      count[key]++;
      counts.set(domain, count);
    }
  };

  const changes = [...keywords].flatMap(([trackingKeywordId, keyword]) => {
    const from = stateOf(runs.from.id, trackingKeywordId);
    const to = stateOf(runs.to.id, trackingKeywordId);
    if (!from || !to) {
      unsaved.push(keyword);
      return [];
    }
    const previous = stateOf(runs.previous?.id, trackingKeywordId) ?? undefined;
    countDomains(previous ?? null, "previous");
    countDomains(from, "from");
    countDomains(to, "to");
    const top10 = setChanges(previous?.top10, from.top10, to.top10);
    const questions = setChanges(
      previous?.questions,
      from.questions,
      to.questions,
    );
    const featureTypes = setChanges(
      previous?.featureTypes,
      from.featureTypes,
      to.featureTypes,
    );
    const positionChange =
      from.position !== null && to.position !== null
        ? from.position - to.position
        : null;
    const changed =
      from.position !== to.position ||
      from.aiOverview !== to.aiOverview ||
      [top10, questions, featureTypes].some(
        (change) => change.added.length > 0 || change.removed.length > 0,
      );
    return [
      {
        trackingKeywordId,
        keyword,
        changed,
        position: {
          previous: previous?.position ?? null,
          from: from.position,
          to: to.position,
          // Positive = moved up. Null when either check didn't find the site.
          change: positionChange,
        },
        top10: { entered: top10.added, left: top10.removed },
        questions,
        aiOverview: {
          previous: previous?.aiOverview ?? null,
          from: from.aiOverview,
          to: to.aiOverview,
        },
        featureTypes,
      },
    ];
  });

  const domains = sortBy(
    [...counts]
      .map(([domain, count]) => ({
        domain,
        ...count,
        delta: count.to - count.from,
      }))
      .filter((row) => row.delta !== 0),
    [(row) => Math.abs(row.delta), "desc"],
    [(row) => row.to, "desc"],
    (row) => row.domain,
  );

  return {
    config,
    device,
    runs,
    keywords: changes,
    notCompared: unsaved,
    domains,
  };
}

export const SerpHistoryService = {
  getKeywordHistory,
  getChanges,
};
