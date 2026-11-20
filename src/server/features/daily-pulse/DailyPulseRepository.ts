import {
  and,
  eq,
  gte,
  inArray,
  lte,
  max,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
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

// D1 binds at most 100 parameters per statement; two go to project and date.
const URLS_PER_QUERY = 90;

/**
 * Which of these page URLs had a row on or before `through`. Looked up per
 * page through the (project, page, date) index, for a handful of candidates.
 */
async function pagesSeenBy(
  projectId: string,
  urls: string[],
  through: string,
): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let i = 0; i < urls.length; i += URLS_PER_QUERY) {
    const rows = await db
      .selectDistinct({ page: gscDailyPage.page })
      .from(gscDailyPage)
      .where(
        and(
          eq(gscDailyPage.projectId, projectId),
          inArray(gscDailyPage.page, urls.slice(i, i + URLS_PER_QUERY)),
          lte(gscDailyPage.date, through),
        ),
      );
    for (const row of rows) seen.add(row.page);
  }
  return seen;
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
  pagesSeenBy,
  siteClickTotals,
  organicSessionTotals,
};
