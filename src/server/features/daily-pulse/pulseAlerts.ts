import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { ga4DateInTimeZone } from "@/server/features/ga4/services/Ga4Dates";
import {
  addDays,
  GSC_TIME_ZONE,
} from "@/server/features/search-archive/archivePlan";
import { SearchArchiveReadRepository } from "@/server/features/search-archive/SearchArchiveReadRepository";
import { SearchArchiveRepository } from "@/server/features/search-archive/SearchArchiveRepository";
import { DailyPulseRepository } from "./DailyPulseRepository";
import { pageAlerts } from "./pageRules";
import {
  buildAlert,
  expectedFrom,
  fellBy,
  windowsEndingAt,
  type PulseAlert,
  type Windows,
} from "./pulseShared";

// The daily pulse: alerts computed from the project's own search archive (no
// Google calls), compared over the last 7 complete days against the 28 days
// before them. Page rules live in pageRules.ts; the site-wide rules here.

/** Site clicks (Search Console) fell at least this much against the baseline pace. */
const SITE_CLICKS_DROP_PERCENT = 40;
/** Sites with fewer baseline clicks are too noisy to judge. */
const SITE_CLICKS_DROP_MIN_BASELINE = 50;
/** GA4 organic sessions fell at least this much against the baseline pace. */
const ORGANIC_DROP_PERCENT = 40;
/** Sites with fewer baseline organic sessions are too noisy to judge. */
const ORGANIC_DROP_MIN_BASELINE_SESSIONS = 50;

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

type SourceStatus =
  | ({ evaluated: true } & Windows)
  | { evaluated: false; reason: string };

type DailyPulse = {
  gsc: SourceStatus;
  ga4: SourceStatus;
  alerts: PulseAlert[];
};

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
 * the bookkeeping tells a quiet day from a missing one.
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
 * source has complete data for. The comparison needs the whole baseline: the
 * archive must have read every day of it (a missing day would read as a
 * drop), and the source must have had data from its first day on. A site
 * whose data starts inside the baseline would have its short baseline read as
 * a month of zeros, so the source is skipped, not scaled.
 */
function resolveWindows(params: {
  requested: string | undefined;
  latestComplete: string;
  /** Days before today the source's data is final; for the skip reason. */
  lagDays: number;
  /** The archive's bookkeeping, per source the rules read. */
  months: ArchivedMonth[][];
  /** The first day the source has any row. */
  firstDataDate: string | null;
  label: string;
}): SourceStatus {
  const { label, firstDataDate } = params;
  if (!firstDataDate || params.months.some((rows) => rows.length === 0)) {
    return { evaluated: false, reason: `The archive has no ${label} data.` };
  }
  if (params.requested && params.requested > params.latestComplete) {
    return {
      evaluated: false,
      reason: `${label}: the last ${params.lagDays} days are not final yet; the latest day to judge is ${params.latestComplete}.`,
    };
  }
  const end = params.requested ?? params.latestComplete;
  const windows = windowsEndingAt(end);
  for (const months of params.months) {
    const missing = firstMissingDay(months, windows.baseline.start, end);
    if (missing) {
      return {
        evaluated: false,
        reason: `The ${label} archive is missing ${missing}; the comparison needs ${windows.baseline.start} – ${end}. Run the archive first.`,
      };
    }
  }
  if (firstDataDate > windows.baseline.start) {
    return {
      evaluated: false,
      reason: `${label} data starts on ${firstDataDate}; the comparison needs a full baseline from ${windows.baseline.start}.`,
    };
  }
  return { evaluated: true, ...windows };
}

const windowParams = (windows: Windows) => ({
  baselineStart: windows.baseline.start,
  baselineEnd: windows.baseline.end,
  recentStart: windows.recent.start,
  recentEnd: windows.recent.end,
});

type Totals = { baseline: number; recent: number };

/** The other site-wide source's change, so a drop in one reads beside the other. */
function otherSourceNote(label: string, totals: Totals | null): string[] {
  if (!totals) return [`${label}: bu dönem için değerlendirilemedi.`];
  const expected = expectedFrom(totals.baseline);
  return [
    `Aynı dönemde ${label}: son 7 günde ${totals.recent}, beklenen ${expected}${
      expected > 0
        ? ` (${Math.round(((totals.recent - expected) / expected) * 100)}%)`
        : ""
    }.`,
  ];
}

function siteClickAlerts(
  windows: Windows,
  clicks: Totals,
  sessions: Totals | null,
): PulseAlert[] {
  if (
    clicks.baseline < SITE_CLICKS_DROP_MIN_BASELINE ||
    !fellBy(clicks.recent, clicks.baseline, SITE_CLICKS_DROP_PERCENT)
  ) {
    return [];
  }
  return [
    buildAlert({
      type: "site_clicks_drop",
      url: null,
      source:
        "Search Console, site geneli, bütün cihazlar (OpenSEO arşivi, gsc_daily_site)",
      metric: "clicks",
      recent: clicks.recent,
      baseline: clicks.baseline,
      windows,
      notes: otherSourceNote("GA4 organik oturumları", sessions),
    }),
  ];
}

function organicAlerts(
  windows: Windows,
  sessions: Totals,
  clicks: Totals | null,
): PulseAlert[] {
  if (
    sessions.baseline < ORGANIC_DROP_MIN_BASELINE_SESSIONS ||
    !fellBy(sessions.recent, sessions.baseline, ORGANIC_DROP_PERCENT)
  ) {
    return [];
  }
  return [
    buildAlert({
      type: "organic_sessions_drop",
      url: null,
      source: "Google Analytics, site geneli (OpenSEO arşivi, ga4_daily_site)",
      metric: "organic_sessions",
      recent: sessions.recent,
      baseline: sessions.baseline,
      windows,
      notes: otherSourceNote("Search Console tıklamaları", clicks),
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
  const [gscPageMonths, gscSiteMonths, ga4Months, gscData, ga4Data, ga4] =
    await Promise.all([
      SearchArchiveRepository.listPeriods(projectId, "gsc_page"),
      SearchArchiveRepository.listPeriods(projectId, "gsc_site"),
      SearchArchiveRepository.listPeriods(projectId, "ga4_site"),
      SearchArchiveReadRepository.dataRange(projectId, "gsc_site"),
      SearchArchiveReadRepository.dataRange(projectId, "ga4_site"),
      Ga4ConnectionRepository.getByProjectId(projectId),
    ]);
  const gsc = resolveWindows({
    requested: options.date,
    latestComplete: addDays(
      ga4DateInTimeZone(now, GSC_TIME_ZONE),
      -GSC_COMPLETE_LAG_DAYS,
    ),
    lagDays: GSC_COMPLETE_LAG_DAYS,
    months: [gscPageMonths, gscSiteMonths],
    firstDataDate: gscData.first,
    label: "Search Console",
  });
  const ga4Status = resolveWindows({
    requested: options.date,
    latestComplete: addDays(
      ga4DateInTimeZone(now, ga4?.propertyTimeZone ?? PULSE_TIME_ZONE),
      -GA4_COMPLETE_LAG_DAYS,
    ),
    lagDays: GA4_COMPLETE_LAG_DAYS,
    months: [ga4Months],
    firstDataDate: ga4Data.first,
    label: "Google Analytics",
  });
  const [clicks, sessions] = await Promise.all([
    gsc.evaluated
      ? DailyPulseRepository.siteClickTotals(projectId, windowParams(gsc))
      : null,
    ga4Status.evaluated
      ? DailyPulseRepository.organicSessionTotals(
          projectId,
          windowParams(ga4Status),
        )
      : null,
  ]);
  const alerts = [
    ...(gsc.evaluated && clicks ? siteClickAlerts(gsc, clicks, sessions) : []),
    ...(gsc.evaluated ? await pageAlerts(projectId, gsc) : []),
    ...(ga4Status.evaluated && sessions
      ? organicAlerts(ga4Status, sessions, clicks)
      : []),
  ];
  return { gsc, ga4: ga4Status, alerts };
}
