import { and, eq, gte, lte, max, min, sql, type SQLWrapper } from "drizzle-orm";
import { db } from "@/db";
import { ga4DailySite, gscDailyPage, gscDailySite } from "@/db/schema";

// Reads of the search archive for the daily pulse. Every query is keyed by the
// project the caller already authorized (or the archive run's own project).

type Windows = {
  baselineStart: string;
  baselineEnd: string;
  recentStart: string;
  recentEnd: string;
};

// SUM of an integer is bigint on Postgres, which the driver returns as a
// string; mapWith(Number) gives both dialects the same number.
const sumBetween = (
  value: SQLWrapper,
  date: SQLWrapper,
  from: string,
  to: string,
) =>
  sql<number>`coalesce(sum(case when ${date} >= ${from} and ${date} <= ${to} then ${value} else 0 end), 0)`.mapWith(
    Number,
  );

/** Per page: clicks and impressions in the baseline and the recent window. */
async function pageTotals(projectId: string, windows: Windows) {
  const { date, clicks, impressions } = gscDailyPage;
  return db
    .select({
      page: gscDailyPage.page,
      baselineClicks: sumBetween(
        clicks,
        date,
        windows.baselineStart,
        windows.baselineEnd,
      ),
      recentClicks: sumBetween(
        clicks,
        date,
        windows.recentStart,
        windows.recentEnd,
      ),
      baselineImpressions: sumBetween(
        impressions,
        date,
        windows.baselineStart,
        windows.baselineEnd,
      ),
      recentImpressions: sumBetween(
        impressions,
        date,
        windows.recentStart,
        windows.recentEnd,
      ),
      // The last day the page had a row: which URL variant is current.
      lastDate: max(date),
    })
    .from(gscDailyPage)
    .where(
      and(
        eq(gscDailyPage.projectId, projectId),
        gte(gscDailyPage.date, windows.baselineStart),
        lte(gscDailyPage.date, windows.recentEnd),
      ),
    )
    .groupBy(gscDailyPage.page);
}

/**
 * Per page: the first day it ever had a row, through `through`. Read over the
 * whole archive, since a page that was quiet in the baseline may be old.
 */
async function pageFirstDates(projectId: string, through: string) {
  const rows = await db
    .select({ page: gscDailyPage.page, first: min(gscDailyPage.date) })
    .from(gscDailyPage)
    .where(
      and(
        eq(gscDailyPage.projectId, projectId),
        lte(gscDailyPage.date, through),
      ),
    )
    .groupBy(gscDailyPage.page);
  return new Map(rows.map((row) => [row.page, row.first ?? through]));
}

/** Search Console site clicks (all devices) in the baseline and the recent window. */
async function siteClickTotals(projectId: string, windows: Windows) {
  const { date, clicks } = gscDailySite;
  const [row] = await db
    .select({
      baseline: sumBetween(
        clicks,
        date,
        windows.baselineStart,
        windows.baselineEnd,
      ),
      recent: sumBetween(clicks, date, windows.recentStart, windows.recentEnd),
    })
    .from(gscDailySite)
    .where(
      and(
        eq(gscDailySite.projectId, projectId),
        gte(gscDailySite.date, windows.baselineStart),
        lte(gscDailySite.date, windows.recentEnd),
      ),
    );
  return { baseline: row?.baseline ?? 0, recent: row?.recent ?? 0 };
}

/** GA4 organic sessions in the baseline and the recent window. */
async function organicSessionTotals(projectId: string, windows: Windows) {
  const { date, organicSessions } = ga4DailySite;
  const [row] = await db
    .select({
      baseline: sumBetween(
        organicSessions,
        date,
        windows.baselineStart,
        windows.baselineEnd,
      ),
      recent: sumBetween(
        organicSessions,
        date,
        windows.recentStart,
        windows.recentEnd,
      ),
    })
    .from(ga4DailySite)
    .where(
      and(
        eq(ga4DailySite.projectId, projectId),
        gte(ga4DailySite.date, windows.baselineStart),
        lte(ga4DailySite.date, windows.recentEnd),
      ),
    );
  return { baseline: row?.baseline ?? 0, recent: row?.recent ?? 0 };
}

export const DailyPulseRepository = {
  pageTotals,
  pageFirstDates,
  siteClickTotals,
  organicSessionTotals,
};
