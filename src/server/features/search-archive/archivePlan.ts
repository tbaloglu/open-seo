import { ga4DateInTimeZone } from "@/server/features/ga4/services/Ga4Dates";

// Which months the search archive job fetches, and from which day. Pure date
// math over YYYY-MM-DD strings, so the rules are testable without Google.

export const ARCHIVE_SOURCES = [
  "gsc_site",
  "gsc_page",
  "gsc_query_page",
  "ga4_site",
  "ga4_page",
] as const;
export type ArchiveSource = (typeof ARCHIVE_SOURCES)[number];
export type ArchiveMode = "backfill" | "incremental";

/**
 * Google revises the latest days of Search Console data for 2-3 days, so a
 * day counts as final once it was read at least this many days after it.
 */
const REVISION_DAYS = 4;
/** GSC keeps 16 months; GA4 is capped at the same window. */
const ARCHIVE_WINDOW_MONTHS = 16;
/** Search Console reports days, and drops them, in Pacific Time. */
export const GSC_TIME_ZONE = "America/Los_Angeles";
/** Incremental runs look at the current month and the two before it. */
const INCREMENTAL_MONTHS = 3;

type ArchivePeriodState = {
  month: string;
  fetchedThrough: string;
  complete: boolean;
  fetchedAt: string;
};

export type ArchiveFetch = {
  source: ArchiveSource;
  month: string;
  startDate: string;
  endDate: string;
  /** Whether this fetch finishes the month for good. */
  complete: boolean;
};

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthStart(month: string): string {
  return `${month}-01`;
}

function monthEnd(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

function addMonths(month: string, months: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex - 1 + months, 1))
    .toISOString()
    .slice(0, 7);
}

/** The first day Google still has: 16 calendar months before `today`. */
export function archiveFloor(today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 - ARCHIVE_WINDOW_MONTHS, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Months from the one holding `from` to the one holding `to`, oldest first. */
function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (
    let month = from.slice(0, 7);
    month <= to.slice(0, 7);
    month = addMonths(month, 1)
  ) {
    months.push(month);
  }
  return months;
}

function firstConsideredMonth(mode: ArchiveMode, floor: string, today: string) {
  return mode === "backfill"
    ? floor
    : monthStart(addMonths(today.slice(0, 7), 1 - INCREMENTAL_MONTHS));
}

/**
 * Daily sources, one fetch per month that is not complete yet, oldest first
 * (the oldest days are the next to leave Google). A month fetched before
 * resumes where its final days end: days read at least REVISION_DAYS after
 * they happened are kept, later ones are read again.
 */
export function planDailyFetches(params: {
  source: ArchiveSource;
  mode: ArchiveMode;
  /** Today in the source's time zone. */
  today: string;
  /** The source's time zone, which `fetchedAt` (UTC) is read in. */
  timeZone: string;
  periods: ArchivePeriodState[];
}): ArchiveFetch[] {
  const { source, mode, today, timeZone } = params;
  const floor = archiveFloor(today);
  const lastDay = addDays(today, -1);
  const finalThrough = addDays(today, -REVISION_DAYS);
  const byMonth = new Map(params.periods.map((p) => [p.month, p]));
  const fetches: ArchiveFetch[] = [];
  for (const month of monthsBetween(
    firstConsideredMonth(mode, floor, today),
    lastDay,
  )) {
    const start = monthStart(month) < floor ? floor : monthStart(month);
    const end = monthEnd(month) > lastDay ? lastDay : monthEnd(month);
    if (start > end) continue;
    const period = byMonth.get(month);
    if (period?.complete) continue;
    let from = start;
    if (period) {
      // Days read at least REVISION_DAYS after they happened are final.
      const finalAtFetch = addDays(
        ga4DateInTimeZone(new Date(period.fetchedAt), timeZone),
        -REVISION_DAYS,
      );
      const resume = addDays(
        period.fetchedThrough < finalAtFetch
          ? period.fetchedThrough
          : finalAtFetch,
        1,
      );
      if (resume > from) from = resume;
    }
    if (from > end) continue;
    fetches.push({
      source,
      month,
      startDate: from,
      endDate: end,
      complete: end === monthEnd(month) && end <= finalThrough,
    });
  }
  return fetches;
}

/**
 * Monthly query × page totals: a month is written once it ended at least
 * REVISION_DAYS ago and Google still has all of it. The latest such month is
 * written again on every run; older ones only until written once.
 */
export function planMonthlyFetches(params: {
  mode: ArchiveMode;
  today: string;
  periods: ArchivePeriodState[];
}): ArchiveFetch[] {
  const { mode, today } = params;
  const floor = archiveFloor(today);
  const finalThrough = addDays(today, -REVISION_DAYS);
  const written = new Set(
    params.periods.filter((p) => p.complete).map((p) => p.month),
  );
  const eligible = monthsBetween(
    firstConsideredMonth(mode, floor, today),
    finalThrough,
  ).filter(
    (month) => monthStart(month) >= floor && monthEnd(month) <= finalThrough,
  );
  const latest = eligible.at(-1);
  return eligible
    .filter((month) => month === latest || !written.has(month))
    .map((month) => ({
      source: "gsc_query_page",
      month,
      startDate: monthStart(month),
      endDate: monthEnd(month),
      complete: true,
    }));
}
