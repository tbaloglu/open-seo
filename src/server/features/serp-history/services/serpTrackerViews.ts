import { reverse, sortBy } from "remeda";
import { isOwnSite } from "@/shared/serp-history";
import { SerpHistoryRepository } from "../repositories/SerpHistoryRepository";
import {
  getValidatedConfig,
  resolveDevice,
  type Device,
} from "./serpHistoryShared";

// Completed checks the run pickers offer.
const MAX_LISTED_RUNS = 50;

function addTo(map: Map<string, Set<string>>, key: string, value: string) {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

type TrackerInput = {
  projectId: string;
  projectDefaultDevice: Device;
  trackerId: string;
  device?: Device;
};

async function trackerAndDevice(input: TrackerInput) {
  const config = await getValidatedConfig(input.trackerId, input.projectId);
  const device = resolveDevice(
    config,
    input.device,
    input.projectDefaultDevice,
  );
  return { config, device };
}

/** The tracker's latest completed full checks, newest first, and whether each one's SERPs were saved. */
export async function listRuns(input: TrackerInput) {
  const { config, device } = await trackerAndDevice(input);
  const runs = await SerpHistoryRepository.getCompletedRuns(
    config.id,
    MAX_LISTED_RUNS,
  );
  const saved = new Set(
    await SerpHistoryRepository.getSavedRunIds(
      runs.map((run) => run.id),
      device,
    ),
  );
  return {
    device,
    runs: runs.map((run) => ({ ...run, saved: saved.has(run.id) })),
  };
}

/** How many of `keywords` each domain ranks for in the run's top 10. */
function countDomains(
  byDomain: Map<string, Set<string>> | undefined,
  keywords?: Set<string>,
) {
  const counts = new Map<string, number>();
  for (const [domain, ranked] of byDomain ?? []) {
    counts.set(
      domain,
      keywords
        ? [...ranked].filter((keyword) => keywords.has(keyword)).length
        : ranked.size,
    );
  }
  return counts;
}

/**
 * Per domain: in how many of the tracker's keywords it ranks in the top 10 at
 * each of the latest `runs` completed checks whose SERPs were saved. The
 * change and who entered or left compare only keywords saved in both of the
 * last two checks, like getChanges, so an added keyword isn't a new entry.
 */
export async function getCompetitors(input: TrackerInput & { runs: number }) {
  const { config, device } = await trackerAndDevice(input);
  const latest = await SerpHistoryRepository.getCompletedRuns(
    config.id,
    input.runs,
  );
  const runIds = latest.map((run) => run.id);
  const [savedRows, domainRows] = await Promise.all([
    SerpHistoryRepository.getSavedKeywords(runIds, device),
    SerpHistoryRepository.getTop10Domains(runIds, device),
  ]);
  const saved = new Map<string, Set<string>>();
  for (const row of savedRows) {
    addTo(saved, row.runId, row.trackingKeywordId);
  }
  const ranking = new Map<string, Map<string, Set<string>>>();
  for (const row of domainRows) {
    if (!row.domain) continue;
    const byDomain = ranking.get(row.runId) ?? new Map<string, Set<string>>();
    ranking.set(row.runId, byDomain);
    addTo(byDomain, row.domain, row.trackingKeywordId);
  }

  // Oldest first, so the columns read left to right in time.
  const runs = reverse(latest.filter((run) => saved.has(run.id)));
  const counts = new Map<string, number[]>();
  runs.forEach((run, index) => {
    for (const [domain, count] of countDomains(ranking.get(run.id))) {
      const row = counts.get(domain) ?? runs.map(() => 0);
      row[index] = count;
      counts.set(domain, row);
    }
  });

  const [previousRun, lastRun] = runs.slice(-2);
  const compared =
    runs.length > 1
      ? new Set(
          [...(saved.get(lastRun.id) ?? [])].filter((keyword) =>
            saved.get(previousRun.id)?.has(keyword),
          ),
        )
      : null;
  const comparedLast =
    compared && countDomains(ranking.get(lastRun.id), compared);
  const comparedPrevious =
    compared && countDomains(ranking.get(previousRun.id), compared);

  const domains = sortBy(
    [...counts].map(([domain, perRun]) => {
      const now = comparedLast?.get(domain) ?? 0;
      const before = comparedPrevious
        ? (comparedPrevious.get(domain) ?? 0)
        : null;
      return {
        domain,
        own: isOwnSite(domain, config.domain),
        counts: perRun,
        latest: perRun.at(-1) ?? 0,
        change: before === null ? null : now - before,
        // In no compared keyword's top 10 before, or in none now.
        status:
          before === null
            ? null
            : before === 0 && now > 0
              ? ("entered" as const)
              : before > 0 && now === 0
                ? ("left" as const)
                : null,
      };
    }),
    [(row) => row.latest, "desc"],
    [(row) => row.counts.reduce((sum, value) => sum + value, 0), "desc"],
    (row) => row.domain,
  );

  return {
    device,
    domain: config.domain,
    runs: runs.map((run) => ({
      id: run.id,
      startedAt: run.startedAt,
      keywords: saved.get(run.id)?.size ?? 0,
    })),
    // Keywords saved in both of the last two checks; null with one check.
    comparedKeywords: compared?.size ?? null,
    // Checks in the window from before SERP history was saved.
    unsavedRuns: latest.length - runs.length,
    domains,
  };
}

/**
 * People Also Ask questions and AI Overview source domains across the
 * tracker's keywords in its latest completed check, with the keywords each
 * one appeared for.
 */
export async function getQuestionsAndSources(input: TrackerInput) {
  const { config, device } = await trackerAndDevice(input);
  const [run] = await SerpHistoryRepository.getCompletedRuns(config.id, 1);
  if (!run) {
    return { device, run: null, keywords: 0, questions: [], sources: [] };
  }
  const [snapshots, savedRows, features] = await Promise.all([
    SerpHistoryRepository.getSnapshots([run.id], device),
    SerpHistoryRepository.getSavedKeywords([run.id], device),
    SerpHistoryRepository.getFeatureValues({
      runId: run.id,
      device,
      featureTypes: ["people_also_ask", "ai_overview"],
    }),
  ]);
  const keywordNames = new Map(
    snapshots.map((row) => [row.trackingKeywordId, row.keyword]),
  );
  const savedKeywords = new Set(savedRows.map((row) => row.trackingKeywordId));
  const questions = new Map<string, Set<string>>();
  const sources = new Map<string, Set<string>>();
  for (const row of features) {
    const keyword =
      keywordNames.get(row.trackingKeywordId) ?? row.trackingKeywordId;
    if (row.featureType === "people_also_ask" && row.value) {
      addTo(questions, row.value, keyword);
    }
    if (row.featureType === "ai_overview" && row.domain) {
      addTo(sources, row.domain, keyword);
    }
  }
  const listed = (map: Map<string, Set<string>>) =>
    sortBy(
      [...map].map(([value, keywords]) => ({
        value,
        keywords: sortBy([...keywords], (keyword) => keyword),
      })),
      [(row) => row.keywords.length, "desc"],
      (row) => row.value,
    );

  return {
    device,
    run: { ...run, saved: savedKeywords.size > 0 },
    keywords: savedKeywords.size,
    questions: listed(questions),
    sources: listed(sources).map((row) => ({
      ...row,
      own: isOwnSite(row.value, config.domain),
    })),
  };
}
