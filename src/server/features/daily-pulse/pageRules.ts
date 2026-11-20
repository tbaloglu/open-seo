import { sortBy } from "remeda";
import { DailyPulseRepository } from "./DailyPulseRepository";
import {
  buildAlert,
  canonicalKey,
  expectedFrom,
  fellBy,
  MAX_ALERTS_PER_RULE,
  RECENT_DAYS,
  BASELINE_DAYS,
  roseBy,
  type PulseAlert,
  type Windows,
} from "./pulseShared";

// The daily pulse's page rules, over Search Console's daily page rows. Google
// reports a page under the host it indexed, and a site moving between
// example.com and www.example.com shows the same page under both, so pages
// are folded by host-less address before they are judged.

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
  /** The variant Google reported most recently: the page's current URL. */
  url: string;
  firstDate: string;
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

function foldPages(rows: PageRow[], firstDates: Map<string, string>) {
  const byKey = new Map<string, PageRow[]>();
  for (const row of rows) {
    const key = canonicalKey(row.page);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey.values()].map((variants): FoldedPage => {
    const [current] = sortBy(
      variants,
      [(row) => row.lastDate ?? "", "desc"],
      [(row) => row.recentImpressions, "desc"],
    );
    const sum = (field: keyof Omit<PageRow, "page" | "lastDate">) =>
      variants.reduce((total, row) => total + row[field], 0);
    return {
      url: current.page,
      firstDate: variants
        .map((row) => firstDates.get(row.page) ?? "")
        .reduce((a, b) => (a < b ? a : b)),
      baselineClicks: sum("baselineClicks"),
      recentClicks: sum("recentClicks"),
      baselineImpressions: sum("baselineImpressions"),
      recentImpressions: sum("recentImpressions"),
      variants,
    };
  });
}

/** The host holding at least HOST_SHARE_PERCENT of a window's impressions. */
function dominantHost(
  variants: PageRow[],
  field: "baselineImpressions" | "recentImpressions",
): string | null {
  const total = variants.reduce((sum, row) => sum + row[field], 0);
  if (total < HOST_CHANGE_MIN_IMPRESSIONS) return null;
  const top = sortBy(variants, [(row) => row[field], "desc"])[0];
  return top[field] * 100 >= total * HOST_SHARE_PERCENT
    ? hostOf(top.page)
    : null;
}

/**
 * One alert per project when pages moved between the www and the bare host:
 * Google indexes the site under the other address, which canonical tags or
 * redirects usually explain.
 */
function hostChangeAlert(
  pages: FoldedPage[],
  windows: Windows,
): PulseAlert | null {
  const moved = pages.flatMap((page) => {
    const before = dominantHost(page.variants, "baselineImpressions");
    const after = dominantHost(page.variants, "recentImpressions");
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

const pageSource = (page: FoldedPage) =>
  `Search Console, sayfa ${page.url}${page.variants.length > 1 ? " (www ve www'siz adresler birlikte)" : ""} (OpenSEO arşivi, gsc_daily_page)`;

/** Traffic drop, page disappeared, rising page and host change alerts. */
export async function pageAlerts(
  projectId: string,
  windows: Windows,
): Promise<PulseAlert[]> {
  const [rows, firstDates] = await Promise.all([
    DailyPulseRepository.pageTotals(projectId, {
      baselineStart: windows.baseline.start,
      baselineEnd: windows.baseline.end,
      recentStart: windows.recent.start,
      recentEnd: windows.recent.end,
    }),
    DailyPulseRepository.pageFirstDates(projectId, windows.recent.end),
  ]);
  const pages = foldPages(rows, firstDates);
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
  // A page first seen after the baseline began is new, not rising: its
  // baseline is short, and scaling it would inflate the rise.
  const rising = pages.filter(
    (page) =>
      page.firstDate <= windows.baseline.start &&
      page.recentImpressions >= RISING_MIN_RECENT_IMPRESSIONS &&
      roseBy(page.recentImpressions, page.baselineImpressions, RISING_PERCENT),
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
    ...sortBy(rising, [
      (page) =>
        page.recentImpressions -
        (page.baselineImpressions * RECENT_DAYS) / BASELINE_DAYS,
      "desc",
    ])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((page) => alert("rising_page", page)),
    ...(hostChange ? [hostChange] : []),
  ];
}
