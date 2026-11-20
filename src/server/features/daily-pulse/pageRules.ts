import { sortBy } from "remeda";
import { DailyPulseRepository } from "./DailyPulseRepository";
import {
  buildAlert,
  canonicalKey,
  expectedFrom,
  fellBy,
  MAX_ALERTS_PER_RULE,
  roseBy,
  type PulseAlert,
  type Windows,
} from "./pulseShared";

// The daily pulse's page rules, over Search Console's daily page rows. Google
// reports a page under the host it indexed, and a site moving between
// example.com and www.example.com shows the same page under both, so pages
// are folded by address without "www." and protocol before they are judged.

/** (a) A page's clicks fell at least this much against the baseline pace. */
const TRAFFIC_DROP_PERCENT = 50;
/** (a) Pages with fewer baseline clicks are too noisy to judge. */
const TRAFFIC_DROP_MIN_BASELINE_CLICKS = 20;
/** (b) A page with this many baseline impressions and none recently. */
const DISAPPEARED_MIN_BASELINE_IMPRESSIONS = 50;
/** (c) A page's impressions rose at least this much against the baseline pace. */
const RISING_PERCENT = 100;
/** (c) ...and reached at least this many impressions in the recent window. */
const RISING_MIN_RECENT_IMPRESSIONS = 100;
/** Host change: the share of a page's impressions on one host that counts as all of them. */
const HOST_SHARE_PERCENT = 80;
/** Host change: pages with fewer impressions in either window are not judged. */
const HOST_CHANGE_MIN_IMPRESSIONS = 10;
/** Host change: example pages named in the evidence. */
const HOST_CHANGE_EXAMPLES = 5;

type PageRow = Awaited<
  ReturnType<typeof DailyPulseRepository.pageTotals>
>[number];

type FoldedPage = {
  /** The variant with most recent impressions: the page's current URL. */
  url: string;
  baselineClicks: number;
  recentClicks: number;
  baselineImpressions: number;
  recentImpressions: number;
  variants: PageRow[];
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

function foldPages(rows: PageRow[]): FoldedPage[] {
  const byKey = new Map<string, PageRow[]>();
  for (const row of rows) {
    const key = canonicalKey(row.page);
    const variants = byKey.get(key);
    if (variants) variants.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.values()].map((variants): FoldedPage => {
    // Where the page gets its impressions now; a stray row on the old
    // address does not make that address current.
    const [current] = sortBy(
      variants,
      [(row) => row.recentImpressions, "desc"],
      [(row) => row.lastDate ?? "", "desc"],
      [(row) => row.baselineImpressions, "desc"],
      [(row) => row.page, "asc"],
    );
    const sum = (field: keyof Omit<PageRow, "page" | "lastDate">) =>
      variants.reduce((total, row) => total + row[field], 0);
    return {
      url: current.page,
      baselineClicks: sum("baselineClicks"),
      recentClicks: sum("recentClicks"),
      baselineImpressions: sum("baselineImpressions"),
      recentImpressions: sum("recentImpressions"),
      variants,
    };
  });
}

/** Impressions per host (case-folded) in one window. */
function impressionsByHost(
  variants: PageRow[],
  field: "baselineImpressions" | "recentImpressions",
): Map<string, number> {
  const byHost = new Map<string, number>();
  for (const row of variants) {
    const host = hostOf(row.page);
    if (host) byHost.set(host, (byHost.get(host) ?? 0) + row[field]);
  }
  return byHost;
}

/** The host holding at least HOST_SHARE_PERCENT of a window's impressions. */
function dominantHost(byHost: Map<string, number>): string | null {
  const total = [...byHost.values()].reduce((sum, value) => sum + value, 0);
  if (total < HOST_CHANGE_MIN_IMPRESSIONS) return null;
  const [host, impressions] = sortBy(
    [...byHost.entries()],
    [([, value]) => value, "desc"],
  )[0];
  return impressions * 100 >= total * HOST_SHARE_PERCENT ? host : null;
}

const hostCount = (page: FoldedPage) =>
  new Set(page.variants.map((row) => hostOf(row.page))).size;

/**
 * One alert per project when pages moved between the www and the bare host:
 * Google indexes the site under the other address, which canonical tags or
 * redirects usually explain.
 *
 * It compares where a page's impressions were across the whole 28-day
 * baseline with where they are in the last 7 days. A switch that began about
 * 6 or more days before the recent window already holds over 20% of the
 * baseline on the new host, so the old host no longer dominates it and the
 * move is not reported. Accepted: the move is reported on the days right
 * after it starts, if the pulse runs then, and the folded page rules judge
 * the page correctly either way.
 */
function hostChangeAlert(
  pages: FoldedPage[],
  windows: Windows,
): PulseAlert | null {
  const moved = pages.flatMap((page) => {
    if (page.variants.length < 2 || hostCount(page) < 2) return [];
    const before = dominantHost(
      impressionsByHost(page.variants, "baselineImpressions"),
    );
    const after = dominantHost(
      impressionsByHost(page.variants, "recentImpressions"),
    );
    return before && after && before !== after ? [{ page, before, after }] : [];
  });
  if (moved.length === 0) return null;
  const toWww = moved.filter(({ after }) => after.startsWith("www.")).length;
  const directions = [
    toWww > 0 ? `${toWww} sayfa www'siz adresten www'ye` : null,
    moved.length - toWww > 0
      ? `${moved.length - toWww} sayfa www'den www'siz adrese`
      : null,
  ].filter(Boolean);
  const examples = sortBy(moved, [({ page }) => page.recentImpressions, "desc"])
    .slice(0, HOST_CHANGE_EXAMPLES)
    .map(({ page, before, after }) => `${page.url} (${before} → ${after})`);
  return buildAlert({
    type: "host_change",
    url: null,
    subject: "www ↔ www'siz",
    source: `Search Console, sayfalar (OpenSEO arşivi, gsc_daily_page): ${directions.join(", ")} taşındı`,
    metric: "impressions",
    recent: moved.reduce((sum, { page }) => sum + page.recentImpressions, 0),
    baseline: moved.reduce(
      (sum, { page }) => sum + page.baselineImpressions,
      0,
    ),
    windows,
    notes: [
      `Sayılar taşınan sayfaların iki adresteki toplamıdır.`,
      `Örnekler: ${examples.join(", ")}.`,
      "Canonical etiketlerini ve 301 yönlendirmelerini kontrol edin.",
    ],
  });
}

function pageSource(page: FoldedPage): string {
  const folded =
    hostCount(page) > 1
      ? " (www ve www'siz adresler birlikte)"
      : new Set(page.variants.map((row) => protocolOf(row.page))).size > 1
        ? " (http ve https adresleri birlikte)"
        : "";
  return `Search Console, sayfa ${page.url}${folded} (OpenSEO arşivi, gsc_daily_page)`;
}

/** Every address Google could report the page under: www or not, http(s). */
function addressVariants(page: FoldedPage): string[] {
  const urls = new Set(page.variants.map((row) => row.page));
  for (const row of page.variants) {
    try {
      const parsed = new URL(row.page);
      const bare = parsed.hostname.toLowerCase().replace(/^www\./, "");
      for (const protocol of ["http:", "https:"]) {
        for (const host of [bare, `www.${bare}`]) {
          urls.add(`${protocol}//${host}${parsed.pathname}${parsed.search}`);
        }
      }
    } catch {
      // An unparsable page is only looked up as reported.
    }
  }
  return [...urls];
}

/** Rising candidates checked per lookup. */
const RISING_CHECK_BATCH = 20;

/**
 * Up to `limit` rising pages that already existed when the baseline began,
 * under any of their addresses, in the candidates' order. A page first seen
 * later is new, not rising: its baseline is short, and scaling it would
 * inflate the rise. Candidates are looked up a batch at a time until enough
 * are found, and a page with no row by then counts as new.
 */
async function establishedRising(
  projectId: string,
  candidates: FoldedPage[],
  baselineStart: string,
  limit: number,
): Promise<FoldedPage[]> {
  const established: FoldedPage[] = [];
  for (
    let i = 0;
    i < candidates.length && established.length < limit;
    i += RISING_CHECK_BATCH
  ) {
    const batch = candidates.slice(i, i + RISING_CHECK_BATCH);
    const seen = await DailyPulseRepository.pagesSeenBy(
      projectId,
      batch.flatMap(addressVariants),
      baselineStart,
    );
    established.push(
      ...batch.filter((page) =>
        addressVariants(page).some((url) => seen.has(url)),
      ),
    );
  }
  return established.slice(0, limit);
}

/** Traffic drop, page disappeared, rising page and host change alerts. */
export async function pageAlerts(
  projectId: string,
  windows: Windows,
): Promise<PulseAlert[]> {
  const rows = await DailyPulseRepository.pageTotals(projectId, {
    baselineStart: windows.baseline.start,
    baselineEnd: windows.baseline.end,
    recentStart: windows.recent.start,
    recentEnd: windows.recent.end,
  });
  const pages = foldPages(rows);
  const disappeared = pages.filter(
    (page) =>
      page.recentImpressions === 0 &&
      page.baselineImpressions >= DISAPPEARED_MIN_BASELINE_IMPRESSIONS,
  );
  // A page that disappeared is reported as that, not also as a drop.
  const disappearedPages = new Set(disappeared);
  const dropped = pages.filter(
    (page) =>
      !disappearedPages.has(page) &&
      page.baselineClicks >= TRAFFIC_DROP_MIN_BASELINE_CLICKS &&
      fellBy(page.recentClicks, page.baselineClicks, TRAFFIC_DROP_PERCENT),
  );
  const risingCandidates = sortBy(
    pages.filter(
      (page) =>
        page.recentImpressions >= RISING_MIN_RECENT_IMPRESSIONS &&
        roseBy(
          page.recentImpressions,
          page.baselineImpressions,
          RISING_PERCENT,
        ),
    ),
    [
      (page) => page.recentImpressions - expectedFrom(page.baselineImpressions),
      "desc",
    ],
  );
  const rising = await establishedRising(
    projectId,
    risingCandidates,
    windows.baseline.start,
    MAX_ALERTS_PER_RULE,
  );
  const alert = (
    type: "traffic_drop" | "page_disappeared" | "rising_page",
    page: FoldedPage,
  ) =>
    buildAlert({
      type,
      url: page.url,
      source: pageSource(page),
      metric: type === "traffic_drop" ? "clicks" : "impressions",
      recent:
        type === "traffic_drop" ? page.recentClicks : page.recentImpressions,
      baseline:
        type === "traffic_drop"
          ? page.baselineClicks
          : page.baselineImpressions,
      windows,
    });
  const hostChange = hostChangeAlert(pages, windows);
  return [
    ...sortBy(dropped, [
      (page) => expectedFrom(page.baselineClicks) - page.recentClicks,
      "desc",
    ])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((page) => alert("traffic_drop", page)),
    ...sortBy(disappeared, [(page) => page.baselineImpressions, "desc"])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((page) => alert("page_disappeared", page)),
    ...rising.map((page) => alert("rising_page", page)),
    ...(hostChange ? [hostChange] : []),
  ];
}
