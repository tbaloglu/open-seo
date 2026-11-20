import {
  and,
  asc,
  desc,
  eq,
  gte,
  lte,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { db } from "@/db";
import {
  ga4DailyPage,
  ga4DailySite,
  gscDailyPage,
  gscDailySite,
  gscMonthlyQueryPage,
} from "@/db/schema";

// Reads of the search archive. Every query is keyed by the project the caller
// already authorized.

// SUM of an integer is bigint on Postgres, which the driver returns as a
// string; mapWith(Number) gives both dialects the same number.
const sumOf = (column: SQLWrapper) =>
  sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
const nullableNumber = (value: unknown) =>
  value === null ? null : Number(value);
/** Average position weighted by impressions, as Search Console reports it. */
const weightedPosition = (position: SQLWrapper, impressions: SQLWrapper) =>
  sql<
    number | null
  >`sum(${position} * ${impressions}) / nullif(sum(${impressions}), 0)`.mapWith(
    nullableNumber,
  );
const summedCtr = (clicks: SQLWrapper, impressions: SQLWrapper) =>
  sql<
    number | null
  >`1.0 * sum(${clicks}) / nullif(sum(${impressions}), 0)`.mapWith(
    nullableNumber,
  );

type DateRange = { startDate: string; endDate: string };
type Paging = { limit: number; offset: number };

/** GSC per day, all devices summed unless `byDevice`. */
async function readGscSite(
  projectId: string,
  range: DateRange & Paging,
  byDevice: boolean,
) {
  const where = and(
    eq(gscDailySite.projectId, projectId),
    gte(gscDailySite.date, range.startDate),
    lte(gscDailySite.date, range.endDate),
  );
  if (byDevice) {
    return db
      .select({
        date: gscDailySite.date,
        device: gscDailySite.device,
        clicks: gscDailySite.clicks,
        impressions: gscDailySite.impressions,
        ctr: gscDailySite.ctr,
        position: gscDailySite.position,
      })
      .from(gscDailySite)
      .where(where)
      .orderBy(asc(gscDailySite.date), asc(gscDailySite.device))
      .limit(range.limit)
      .offset(range.offset);
  }
  return db
    .select({
      date: gscDailySite.date,
      clicks: sumOf(gscDailySite.clicks),
      impressions: sumOf(gscDailySite.impressions),
      ctr: summedCtr(gscDailySite.clicks, gscDailySite.impressions),
      position: weightedPosition(
        gscDailySite.position,
        gscDailySite.impressions,
      ),
    })
    .from(gscDailySite)
    .where(where)
    .groupBy(gscDailySite.date)
    .orderBy(asc(gscDailySite.date))
    .limit(range.limit)
    .offset(range.offset);
}

/** One page per day, or every page's totals over the range by clicks. */
async function readGscPages(
  projectId: string,
  range: DateRange & Paging,
  page?: string,
) {
  const where = and(
    eq(gscDailyPage.projectId, projectId),
    gte(gscDailyPage.date, range.startDate),
    lte(gscDailyPage.date, range.endDate),
    page ? eq(gscDailyPage.page, page) : undefined,
  );
  if (page) {
    return db
      .select({
        date: gscDailyPage.date,
        page: gscDailyPage.page,
        clicks: gscDailyPage.clicks,
        impressions: gscDailyPage.impressions,
        ctr: gscDailyPage.ctr,
        position: gscDailyPage.position,
      })
      .from(gscDailyPage)
      .where(where)
      .orderBy(asc(gscDailyPage.date))
      .limit(range.limit)
      .offset(range.offset);
  }
  const clicks = sumOf(gscDailyPage.clicks);
  return db
    .select({
      page: gscDailyPage.page,
      clicks,
      impressions: sumOf(gscDailyPage.impressions),
      ctr: summedCtr(gscDailyPage.clicks, gscDailyPage.impressions),
      position: weightedPosition(
        gscDailyPage.position,
        gscDailyPage.impressions,
      ),
    })
    .from(gscDailyPage)
    .where(where)
    .groupBy(gscDailyPage.page)
    .orderBy(desc(clicks), asc(gscDailyPage.page))
    .limit(range.limit)
    .offset(range.offset);
}

async function readGscQueryPages(
  projectId: string,
  range: { startMonth: string; endMonth: string } & Paging,
  filter: { page?: string; query?: string },
) {
  return db
    .select({
      month: gscMonthlyQueryPage.month,
      query: gscMonthlyQueryPage.query,
      page: gscMonthlyQueryPage.page,
      clicks: gscMonthlyQueryPage.clicks,
      impressions: gscMonthlyQueryPage.impressions,
      ctr: gscMonthlyQueryPage.ctr,
      position: gscMonthlyQueryPage.position,
    })
    .from(gscMonthlyQueryPage)
    .where(
      and(
        eq(gscMonthlyQueryPage.projectId, projectId),
        gte(gscMonthlyQueryPage.month, range.startMonth),
        lte(gscMonthlyQueryPage.month, range.endMonth),
        filter.page ? eq(gscMonthlyQueryPage.page, filter.page) : undefined,
        filter.query ? eq(gscMonthlyQueryPage.query, filter.query) : undefined,
      ),
    )
    .orderBy(
      asc(gscMonthlyQueryPage.month),
      desc(gscMonthlyQueryPage.clicks),
      desc(gscMonthlyQueryPage.impressions),
      asc(gscMonthlyQueryPage.query),
      asc(gscMonthlyQueryPage.page),
    )
    .limit(range.limit)
    .offset(range.offset);
}

async function readGa4Site(projectId: string, range: DateRange & Paging) {
  return db
    .select({
      date: ga4DailySite.date,
      sessions: ga4DailySite.sessions,
      organicSessions: ga4DailySite.organicSessions,
      keyEvents: ga4DailySite.keyEvents,
      organicKeyEvents: ga4DailySite.organicKeyEvents,
    })
    .from(ga4DailySite)
    .where(
      and(
        eq(ga4DailySite.projectId, projectId),
        gte(ga4DailySite.date, range.startDate),
        lte(ga4DailySite.date, range.endDate),
      ),
    )
    .orderBy(asc(ga4DailySite.date))
    .limit(range.limit)
    .offset(range.offset);
}

async function readGa4Pages(
  projectId: string,
  range: DateRange & Paging,
  pagePath?: string,
) {
  const where = and(
    eq(ga4DailyPage.projectId, projectId),
    gte(ga4DailyPage.date, range.startDate),
    lte(ga4DailyPage.date, range.endDate),
    pagePath ? eq(ga4DailyPage.pagePath, pagePath) : undefined,
  );
  if (pagePath) {
    return db
      .select({
        date: ga4DailyPage.date,
        pagePath: ga4DailyPage.pagePath,
        organicSessions: ga4DailyPage.organicSessions,
      })
      .from(ga4DailyPage)
      .where(where)
      .orderBy(asc(ga4DailyPage.date))
      .limit(range.limit)
      .offset(range.offset);
  }
  const sessions = sumOf(ga4DailyPage.organicSessions);
  return db
    .select({ pagePath: ga4DailyPage.pagePath, organicSessions: sessions })
    .from(ga4DailyPage)
    .where(where)
    .groupBy(ga4DailyPage.pagePath)
    .orderBy(desc(sessions), asc(ga4DailyPage.pagePath))
    .limit(range.limit)
    .offset(range.offset);
}

export const SearchArchiveReadRepository = {
  readGscSite,
  readGscPages,
  readGscQueryPages,
  readGa4Site,
  readGa4Pages,
};
