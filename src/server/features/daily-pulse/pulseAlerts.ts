import { sortBy } from "remeda";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { ga4DateInTimeZone } from "@/server/features/ga4/services/Ga4Dates";
import {
  addDays,
  GSC_TIME_ZONE,
} from "@/server/features/search-archive/archivePlan";
import { SearchArchiveRepository } from "@/server/features/search-archive/SearchArchiveRepository";
import {
  SEO_TASK_MAX_TITLE_CHARS,
  type SeoTaskPriority,
} from "@/shared/seo-tasks";
import { DailyPulseRepository } from "./DailyPulseRepository";

// The daily pulse: alerts computed from the project's own search archive (no
// Google calls), compared over the last 7 complete days against the 28 days
// before them. After each successful archive run the alerts are written to
// the project's SEO tasks as proposals, one open task per alert and page.

/** Days in the window being judged, and in the baseline before it. */
const RECENT_DAYS = 7;
const BASELINE_DAYS = 28;

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
/** (d) GA4 organic sessions fell at least this much against the baseline pace. */
const ORGANIC_DROP_PERCENT = 40;
/** (d) Sites with fewer baseline organic sessions are too noisy to judge. */
const ORGANIC_DROP_MIN_BASELINE_SESSIONS = 50;

/** Alerts kept per rule, the largest first, so a site-wide dip stays readable. */
const MAX_ALERTS_PER_RULE = 10;

/**
 * Search Console revises its latest days (the archive reads them with
 * dataState "all"), so the recent window ends this many days before today in
 * Pacific Time.
 */
const GSC_COMPLETE_LAG_DAYS = 3;
/** GA4 can take up to two days to finish processing a day. */
const GA4_COMPLETE_LAG_DAYS = 2;

/** Alert codes and the default GA4 time zone are the owner's: Istanbul. */
export const PULSE_TIME_ZONE = "Europe/Istanbul";

export const PULSE_ALERT_TYPES = [
  "traffic_drop",
  "page_disappeared",
  "rising_page",
  "organic_sessions_drop",
] as const;
export type PulseAlertType = (typeof PULSE_ALERT_TYPES)[number];

/** The title prefix of each alert type; it also identifies the type on a task. */
export const TITLE_LABELS: Record<PulseAlertType, string> = {
  traffic_drop: "Trafik düşüşü",
  page_disappeared: "Gösterim kesildi",
  rising_page: "Gösterim artışı",
  organic_sessions_drop: "Organik oturum düşüşü",
};

type DateWindow = { start: string; end: string };
type Windows = { recent: DateWindow; baseline: DateWindow };

type PulseAlert = {
  type: PulseAlertType;
  /** The page the alert is about; null for site-wide alerts. */
  url: string | null;
  title: string;
  priority: SeoTaskPriority;
  metric: "clicks" | "impressions" | "organic_sessions";
  recent: number;
  baseline: number;
  /** The baseline's daily average × 7: what the recent window would be at the same pace. */
  expected: number;
  /** Change of `recent` against `expected`, rounded; null when expected is 0. */
  changePercent: number | null;
  recentWindow: DateWindow;
  baselineWindow: DateWindow;
  evidence: string;
};

type SourceStatus =
  | ({ evaluated: true } & Windows)
  | { evaluated: false; reason: string };

type DailyPulse = {
  gsc: SourceStatus;
  ga4: SourceStatus;
  alerts: PulseAlert[];
};

function windowsEndingAt(end: string): Windows {
  const recentStart = addDays(end, 1 - RECENT_DAYS);
  const baselineEnd = addDays(recentStart, -1);
  return {
    recent: { start: recentStart, end },
    baseline: {
      start: addDays(baselineEnd, 1 - BASELINE_DAYS),
      end: baselineEnd,
    },
  };
}

/** Whether `recent` fell at least `percent` below the baseline's pace. */
function fellBy(recent: number, baseline: number, percent: number) {
  // Integer math: recent × 28 × 100 ≤ baseline × 7 × (100 − percent).
  return (
    recent * BASELINE_DAYS * 100 <= baseline * RECENT_DAYS * (100 - percent)
  );
}

/** Whether `recent` rose at least `percent` above the baseline's pace. */
function roseBy(recent: number, baseline: number, percent: number) {
  return (
    recent * BASELINE_DAYS * 100 >= baseline * RECENT_DAYS * (100 + percent)
  );
}

const expectedFrom = (baseline: number) =>
  Math.round(((baseline * RECENT_DAYS) / BASELINE_DAYS) * 10) / 10;

function changePercent(recent: number, baseline: number): number | null {
  const expected = (baseline * RECENT_DAYS) / BASELINE_DAYS;
  return expected === 0
    ? null
    : Math.round(((recent - expected) / expected) * 100);
}

/**
 * The page's path for a short title, percent-decoded so Turkish letters read
 * as letters; the URL itself if unparsable.
 */
function pathOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname || url;
  } catch {
    return url;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** "<label>: <subject>", cut to the task title limit with the label kept. */
function alertTitle(type: PulseAlertType, subject: string): string {
  const title = `${TITLE_LABELS[type]}: ${subject}`;
  return title.length <= SEO_TASK_MAX_TITLE_CHARS
    ? title
    : `${title.slice(0, SEO_TASK_MAX_TITLE_CHARS - 1)}…`;
}

/**
 * The evidence's first line names the alert type, so a task stays matched to
 * its alert even after its title is edited.
 */
export const markerOf = (type: PulseAlertType) => `[nabız: ${type}]`;

const METRIC_LABELS: Record<PulseAlert["metric"], string> = {
  clicks: "tıklama",
  impressions: "gösterim",
  organic_sessions: "organik oturum",
};

function buildAlert(params: {
  type: PulseAlertType;
  url: string | null;
  metric: PulseAlert["metric"];
  recent: number;
  baseline: number;
  windows: Windows;
}): PulseAlert {
  const { type, url, metric, recent, baseline, windows } = params;
  const expected = expectedFrom(baseline);
  const change = changePercent(recent, baseline);
  const unit = METRIC_LABELS[metric];
  const source =
    metric === "organic_sessions"
      ? "Google Analytics, site geneli (OpenSEO arşivi, ga4_daily_site)"
      : `Search Console, sayfa ${url} (OpenSEO arşivi, gsc_daily_page)`;
  const evidence = [
    markerOf(type),
    `${source}.`,
    `Son ${RECENT_DAYS} gün (${windows.recent.start} – ${windows.recent.end}): ${recent} ${unit}.`,
    `Önceki ${BASELINE_DAYS} gün (${windows.baseline.start} – ${windows.baseline.end}): ${baseline} ${unit}; aynı tempoyla ${RECENT_DAYS} günde beklenen ${expected}.`,
    change === null ? null : `Değişim: ${change > 0 ? "+" : ""}${change}%.`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    type,
    url,
    title: alertTitle(type, url ? pathOf(url) : "site geneli"),
    priority: type === "rising_page" ? "medium" : "high",
    metric,
    recent,
    baseline,
    expected,
    changePercent: change,
    recentWindow: windows.recent,
    baselineWindow: windows.baseline,
    evidence,
  };
}

type ArchivedMonth = { month: string; fetchedThrough: string };

/** The last day of a YYYY-MM month. */
function monthEnd(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

/**
 * The first day in [start, end] the archive has not read, or null when every
 * day is covered. Checked month by month against the job's bookkeeping, not
 * the rows: a page (or a whole site) with no impressions has no rows, so only
 * the bookkeeping tells a quiet day from a missing one. A month's fetches
 * always start on its first day (the 16-month floor is far behind any pulse
 * window), so a month row covers its days through `fetchedThrough`.
 */
function firstMissingDay(
  months: ArchivedMonth[],
  start: string,
  end: string,
): string | null {
  const byMonth = new Map(months.map((row) => [row.month, row.fetchedThrough]));
  for (let day = start; day <= end; ) {
    const month = day.slice(0, 7);
    const needed = monthEnd(month) < end ? monthEnd(month) : end;
    const through = byMonth.get(month);
    if (!through) return day;
    if (through < needed) return addDays(through, 1);
    day = addDays(needed, 1);
  }
  return null;
}

/**
 * The window ends on the requested day, or by default on the latest day the
 * source has complete data for. The archive must cover the whole baseline and
 * recent window, or a missing day would read as a drop; a stale or gappy
 * archive skips the source instead.
 */
function resolveWindows(params: {
  requested: string | undefined;
  latestComplete: string;
  months: ArchivedMonth[];
  label: string;
}): SourceStatus {
  const { months, label } = params;
  if (months.length === 0) {
    return { evaluated: false, reason: `The archive has no ${label} data.` };
  }
  const end = params.requested ?? params.latestComplete;
  const windows = windowsEndingAt(end);
  const missing = firstMissingDay(months, windows.baseline.start, end);
  if (missing) {
    return {
      evaluated: false,
      reason: `The ${label} archive is missing ${missing}; the comparison needs ${windows.baseline.start} – ${end}. Run the archive first.`,
    };
  }
  return { evaluated: true, ...windows };
}

async function pageAlerts(projectId: string, windows: Windows) {
  const rows = await DailyPulseRepository.pageTotals(projectId, {
    baselineStart: windows.baseline.start,
    baselineEnd: windows.baseline.end,
    recentStart: windows.recent.start,
    recentEnd: windows.recent.end,
  });
  const disappeared = rows.filter(
    (row) =>
      row.recentImpressions === 0 &&
      row.baselineImpressions >= DISAPPEARED_MIN_BASELINE_IMPRESSIONS,
  );
  const disappearedPages = new Set(disappeared.map((row) => row.page));
  // A page that disappeared is reported as that, not also as a drop.
  const dropped = rows.filter(
    (row) =>
      !disappearedPages.has(row.page) &&
      row.baselineClicks >= TRAFFIC_DROP_MIN_BASELINE_CLICKS &&
      fellBy(row.recentClicks, row.baselineClicks, TRAFFIC_DROP_PERCENT),
  );
  const rising = rows.filter(
    (row) =>
      row.recentImpressions >= RISING_MIN_RECENT_IMPRESSIONS &&
      roseBy(row.recentImpressions, row.baselineImpressions, RISING_PERCENT),
  );
  return [
    ...sortBy(dropped, [
      (row) => expectedFrom(row.baselineClicks) - row.recentClicks,
      "desc",
    ])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((row) =>
        buildAlert({
          type: "traffic_drop",
          url: row.page,
          metric: "clicks",
          recent: row.recentClicks,
          baseline: row.baselineClicks,
          windows,
        }),
      ),
    ...sortBy(disappeared, [(row) => row.baselineImpressions, "desc"])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((row) =>
        buildAlert({
          type: "page_disappeared",
          url: row.page,
          metric: "impressions",
          recent: 0,
          baseline: row.baselineImpressions,
          windows,
        }),
      ),
    ...sortBy(rising, [
      (row) => row.recentImpressions - expectedFrom(row.baselineImpressions),
      "desc",
    ])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((row) =>
        buildAlert({
          type: "rising_page",
          url: row.page,
          metric: "impressions",
          recent: row.recentImpressions,
          baseline: row.baselineImpressions,
          windows,
        }),
      ),
  ];
}

async function organicAlerts(projectId: string, windows: Windows) {
  const totals = await DailyPulseRepository.organicSessionTotals(projectId, {
    baselineStart: windows.baseline.start,
    baselineEnd: windows.baseline.end,
    recentStart: windows.recent.start,
    recentEnd: windows.recent.end,
  });
  if (
    totals.baseline < ORGANIC_DROP_MIN_BASELINE_SESSIONS ||
    !fellBy(totals.recent, totals.baseline, ORGANIC_DROP_PERCENT)
  ) {
    return [];
  }
  return [
    buildAlert({
      type: "organic_sessions_drop",
      url: null,
      metric: "organic_sessions",
      recent: totals.recent,
      baseline: totals.baseline,
      windows,
    }),
  ];
}

/**
 * The alerts for a project. `date` is the last day of the 7-day window; by
 * default it is the latest complete day per source (Search Console: 3 days
 * ago in Pacific Time; Analytics: 2 days ago in the property time zone).
 * Read-only.
 */
export async function compute(
  projectId: string,
  options: { date?: string; now?: Date } = {},
): Promise<DailyPulse> {
  const now = options.now ?? new Date();
  const [gscMonths, ga4Months, ga4] = await Promise.all([
    SearchArchiveRepository.listPeriods(projectId, "gsc_page"),
    SearchArchiveRepository.listPeriods(projectId, "ga4_site"),
    Ga4ConnectionRepository.getByProjectId(projectId),
  ]);
  const gsc = resolveWindows({
    requested: options.date,
    latestComplete: addDays(
      ga4DateInTimeZone(now, GSC_TIME_ZONE),
      -GSC_COMPLETE_LAG_DAYS,
    ),
    months: gscMonths,
    label: "Search Console page",
  });
  const ga4Status = resolveWindows({
    requested: options.date,
    latestComplete: addDays(
      ga4DateInTimeZone(now, ga4?.propertyTimeZone ?? PULSE_TIME_ZONE),
      -GA4_COMPLETE_LAG_DAYS,
    ),
    months: ga4Months,
    label: "Google Analytics",
  });
  const alerts = [
    ...(gsc.evaluated ? await pageAlerts(projectId, gsc) : []),
    ...(ga4Status.evaluated ? await organicAlerts(projectId, ga4Status) : []),
  ];
  return { gsc, ga4: ga4Status, alerts };
}
