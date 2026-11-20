import { and, eq, gte, lte, sql, type SQLWrapper } from "drizzle-orm";
import { db } from "@/db";
import { ga4DailySite, gscDailyPage } from "@/db/schema";

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
  organicSessionTotals,
};
