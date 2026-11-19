import { featureContents } from "@/server/features/keywords/services/research/serpFeatures";
import type { SerpLiveItem } from "@/server/lib/dataforseo";
import {
  SerpHistoryRepository,
  type SerpPageRows,
} from "../repositories/SerpHistoryRepository";

const TOP_RESULTS = 10;
const MAX_VALUES_PER_FEATURE = 10;
const MAX_VALUE_LENGTH = 150;
const GOOGLE_HOST = /^google\.[a-z.]+$/;

type Device = "desktop" | "mobile";
type PageContent = Pick<SerpPageRows, "results" | "features">;

/** One read of a keyword/device pair, with what its page showed. */
export type SerpRead = {
  keywordId: string;
  device: Device;
  position: number | null;
} & PageContent;

/** Bare lowercase host; Google itself is never credited. */
function site(domain: string | null | undefined): string | null {
  const host = domain
    ?.trim()
    .toLowerCase()
    .replace(/^www\./, "");
  return host && !GOOGLE_HOST.test(host) ? host : null;
}

/**
 * The top organic results and each feature's values, read from the page as
 * soon as it is collected so the page itself isn't held. A feature whose
 * content can't be read keeps its own title and site (a local pack row is a
 * business, a featured snippet names its site), or a null value, so its
 * presence stays.
 */
export function readSerpPage(items: SerpLiveItem[]): PageContent {
  const results: PageContent["results"] = [];
  const valuesByType = new Map<
    string,
    Array<{ value: string | null; domain: string | null }>
  >();
  for (const item of items) {
    if (item.type === "organic") {
      const rank = item.rank_group ?? results.length + 1;
      if (
        results.length < TOP_RESULTS &&
        !results.some((row) => row.rank === rank)
      ) {
        results.push({
          rank,
          domain: site(item.domain),
          url: item.url ?? null,
          title: item.title?.slice(0, 300) ?? null,
        });
      }
      continue;
    }
    const values = valuesByType.get(item.type) ?? [];
    valuesByType.set(item.type, values);
    const contents = featureContents(item);
    const entries =
      contents.length > 0
        ? contents.map((entry) => ({
            value: entry.value,
            domain: site(entry.domain),
          }))
        : [
            {
              value: item.title?.slice(0, MAX_VALUE_LENGTH) || null,
              domain: site(item.domain),
            },
          ];
    for (const entry of entries) {
      const duplicate = values.some(
        (saved) => saved.value === entry.value && saved.domain === entry.domain,
      );
      if (!duplicate && values.length < MAX_VALUES_PER_FEATURE) {
        values.push(entry);
      }
    }
  }
  const features = [...valuesByType].flatMap(([featureType, values]) =>
    values.map((entry, sortOrder) => ({ featureType, sortOrder, ...entry })),
  );
  return { results, features };
}

/**
 * Save the SERP behind each read, alongside the run's rank snapshots. A pair
 * keeps the page of the read its snapshot keeps: its first answer, replaced
 * only by a read that ranks the site higher (see rankCheckRetries). Runs
 * before the snapshot write, so a first read always counts as a first answer.
 * History is a by-product of the check: a failure is logged, never thrown.
 */
export async function saveSerpHistory(runId: string, reads: SerpRead[]) {
  if (reads.length === 0) return;
  try {
    const saved = new Map(
      (await SerpHistoryRepository.getSnapshotPositions(runId)).map((row) => [
        `${row.trackingKeywordId}:${row.device}`,
        row.position,
      ]),
    );
    const toSave = reads.filter((read) => {
      const key = `${read.keywordId}:${read.device}`;
      if (!saved.has(key)) return true;
      const best = saved.get(key) ?? null;
      return read.position !== null && (best === null || read.position < best);
    });
    await SerpHistoryRepository.replacePages(
      runId,
      toSave.map((read) => ({
        trackingKeywordId: read.keywordId,
        device: read.device,
        results: read.results,
        features: read.features,
      })),
    );
  } catch (error) {
    console.error(`[rank-check] ${runId} SERP history save failed:`, error);
  }
}

/** Drop the pages of pairs whose miss the check discarded as unconfirmed. */
export async function dropSerpHistory(
  runId: string,
  pairs: Array<{ trackingKeywordId: string; device: Device }>,
) {
  if (pairs.length === 0) return;
  try {
    await SerpHistoryRepository.deletePages(runId, pairs);
  } catch (error) {
    console.error(`[rank-check] ${runId} SERP history drop failed:`, error);
  }
}
