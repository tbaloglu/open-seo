import { sortBy } from "remeda";
import { AppError } from "@/server/lib/errors";
import { SerpHistoryRepository } from "../repositories/SerpHistoryRepository";
import {
  getValidatedConfig,
  indexPages,
  isOwnSite,
  pageKey,
  resolveDevice,
  type Device,
  type SavedPage,
} from "./serpHistoryShared";

// ---------------------------------------------------------------------------
// Changes between two checks
//
// One check is one read, and Google varies between reads, so a change seen
// only in the latest check ("changed") may be noise. With a check before
// `from` saved too, a change between it and `from` that the latest check
// still shows "held" for two checks. The same rule applies to every field.
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
type Status = "unchanged" | "changed" | "held";

/**
 * What was added and removed between `from` and `to` (`persisted: false`),
 * plus changes between `previous` and `from` that `to` still shows
 * (`persisted: true`).
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

/** A single value's change, by the same rule as setChanges. */
function valueStatus<T>(previous: T | undefined, from: T, to: T): Status {
  if (from !== to) return "changed";
  if (previous !== undefined && previous !== from) return "held";
  return "unchanged";
}

function pageState(
  page: SavedPage | undefined,
  position: number | null,
  domain: string,
): PageState | undefined {
  if (!page) return undefined;
  const aiSources = page.features.filter(
    (row) => row.featureType === "ai_overview",
  );
  return {
    position,
    top10: new Set(
      page.results.flatMap((row) => (row.domain === null ? [] : [row.domain])),
    ),
    questions: new Set(
      page.features.flatMap((row) =>
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
    featureTypes: new Set(page.features.map((row) => row.featureType)),
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
    previous: runs.at(fromIndex + 1),
  };
}

/** Per domain: in how many compared keywords' top 10 it appears. */
type DomainCount = {
  from: number;
  to: number;
  // Over the keywords whose previous page was saved only, so the two compare
  // like with like.
  previous: number;
  toWithPrevious: number;
};

/**
 * What changed on the tracker's SERPs between two completed full checks, by
 * default the latest two, with the check before `from` used to tell changes
 * that held from single-check ones.
 */
export async function getChanges(input: {
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
  const [snapshots, pageRows] = await Promise.all([
    SerpHistoryRepository.getSnapshots(runIds, device),
    SerpHistoryRepository.getPages({ runIds, device }),
  ]);
  const pages = indexPages(pageRows);
  const position = new Map(
    snapshots.map((row) => [
      pageKey(row.runId, row.trackingKeywordId),
      row.position,
    ]),
  );
  const stateOf = (runId: string | undefined, trackingKeywordId: string) => {
    if (!runId) return undefined;
    const key = pageKey(runId, trackingKeywordId);
    return pageState(pages.get(key), position.get(key) ?? null, config.domain);
  };

  const keywords = new Map(
    snapshots
      .filter((row) => row.runId === runs.to.id || row.runId === runs.from.id)
      .map((row) => [row.trackingKeywordId, row.keyword]),
  );
  const notCompared: string[] = [];
  const counts = new Map<string, DomainCount>();
  const count = (domains: Set<string>, field: keyof DomainCount) => {
    for (const domain of domains) {
      const row = counts.get(domain) ?? {
        from: 0,
        to: 0,
        previous: 0,
        toWithPrevious: 0,
      };
      row[field]++;
      counts.set(domain, row);
    }
  };
  let previousCompared = false;

  const changes = [...keywords].flatMap(([trackingKeywordId, keyword]) => {
    const from = stateOf(runs.from.id, trackingKeywordId);
    const to = stateOf(runs.to.id, trackingKeywordId);
    if (!from || !to) {
      notCompared.push(keyword);
      return [];
    }
    const previous = stateOf(runs.previous?.id, trackingKeywordId);
    count(from.top10, "from");
    count(to.top10, "to");
    if (previous) {
      previousCompared = true;
      count(previous.top10, "previous");
      count(to.top10, "toWithPrevious");
    }
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
    const positionStatus = valueStatus(
      previous?.position,
      from.position,
      to.position,
    );
    const aiOverviewStatus = valueStatus(
      previous?.aiOverview,
      from.aiOverview,
      to.aiOverview,
    );
    const changed =
      positionStatus !== "unchanged" ||
      aiOverviewStatus !== "unchanged" ||
      [top10, questions, featureTypes].some(
        (change) => change.added.length > 0 || change.removed.length > 0,
      );
    return [
      {
        trackingKeywordId,
        keyword,
        changed,
        position: {
          previous: previous ? previous.position : null,
          from: from.position,
          to: to.position,
          // Positive = moved up. Null when either check didn't find the site.
          change:
            from.position !== null && to.position !== null
              ? from.position - to.position
              : null,
          status: positionStatus,
        },
        top10: { entered: top10.added, left: top10.removed },
        questions,
        aiOverview: {
          previous: previous?.aiOverview ?? null,
          from: from.aiOverview,
          to: to.aiOverview,
          status: aiOverviewStatus,
        },
        featureTypes,
      },
    ];
  });

  const domains = sortBy(
    [...counts]
      .map(([domain, row]) => ({
        domain,
        previous: previousCompared ? row.previous : null,
        from: row.from,
        to: row.to,
        delta: row.to - row.from,
        // Change since the check before `from`, which a held gain shows
        // while `delta` is 0.
        deltaSincePrevious: previousCompared
          ? row.toWithPrevious - row.previous
          : null,
      }))
      .filter(
        (row) =>
          row.delta !== 0 ||
          (row.deltaSincePrevious !== null && row.deltaSincePrevious !== 0),
      ),
    [
      (row) =>
        Math.max(Math.abs(row.delta), Math.abs(row.deltaSincePrevious ?? 0)),
      "desc",
    ],
    [(row) => row.to, "desc"],
    (row) => row.domain,
  );

  return {
    config,
    device,
    runs: {
      to: runs.to,
      from: runs.from,
      // Only when some keyword's page from that check was saved.
      previous: previousCompared ? (runs.previous ?? null) : null,
    },
    keywords: changes,
    notCompared,
    domains,
  };
}
