import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { ga4DateInTimeZone } from "@/server/features/ga4/services/Ga4Dates";
import {
  normalizeGa4Response,
  type Ga4Quota,
} from "@/server/features/ga4/services/Ga4ReportNormalization";
import { mapGa4ReportError } from "@/server/features/ga4/services/Ga4ReportingService";
import { GscService } from "@/server/features/gsc/services/GscService";
import type { GscDimension } from "@/server/features/gsc/searchAnalytics";
import { AppError } from "@/server/lib/errors";
import { Ga4DataApiError, Ga4ReportError } from "@/server/lib/ga4Errors";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
import {
  createGa4DataClient,
  type Ga4RunReportRequest,
} from "@/server/lib/ga4Client";
import {
  addDays,
  archiveFloor,
  GSC_TIME_ZONE,
  type ArchiveFetch,
} from "./archivePlan";
import { SearchArchiveRepository } from "./SearchArchiveRepository";

// Fetches one month of one source for the search archive. It reads through
// the same service and client as the live tools (their token, gateway and
// error handling), one request at a time, and writes page by page so a large
// month never sits in memory whole.

/** Google's maximum Search Analytics page. */
const GSC_PAGE_SIZE = 25_000;
const GA4_PAGE_SIZE = 25_000;
/** A runaway guard: 40 pages of 25,000 rows is a million rows per month. */
const MAX_PAGES = 40;
/**
 * Below this many GA4 tokens left in the property's hour, the run pauses
 * before its next month instead of running into the quota.
 */
const GA4_LOW_HOURLY_TOKENS = 2_000;
const GA4_LOW_QUOTA_PAUSE_SECONDS = 15 * 60;

/** A source Google says is switched off for this deployment. */
class ArchiveSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveSourceUnavailableError";
  }
}

/** Reasons Search Console gives on a 403 that are quota, not access. */
const GSC_RATE_LIMIT_REASONS = [
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
];

/**
 * Failures a retry cannot fix: a revoked grant, a lost property, a source
 * that is not connected or whose API is switched off. Quota, rate limits,
 * timeouts and outages are worth retrying.
 */
export function isPermanentArchiveError(error: unknown): boolean {
  if (
    error instanceof GscTokenError ||
    error instanceof GscNotConnectedError ||
    error instanceof ArchiveSourceUnavailableError ||
    error instanceof AppError
  ) {
    return true;
  }
  if (error instanceof GscApiError) {
    if (error.apiDisabled) return true;
    if (
      error.status === 403 &&
      GSC_RATE_LIMIT_REASONS.some((reason) => error.body?.includes(reason))
    ) {
      return false;
    }
    return [400, 401, 403, 404].includes(error.status);
  }
  if (error instanceof Ga4ReportError) {
    return (
      error.code !== "ga4_quota_exhausted" &&
      error.code !== "ga4_upstream_unavailable"
    );
  }
  return false;
}

type FetchOutcome = {
  rows: number;
  /** Seconds to wait before the next month, when the quota runs low. */
  pauseSeconds: number;
};

type GscRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/**
 * Every page of a Search Analytics query, handed to `write` page by page.
 * `truncated` when MAX_PAGES ran out before Google did.
 */
async function eachGscPage(
  projectId: string,
  range: { startDate: string; endDate: string },
  dimensions: GscDimension[],
  write: (rows: GscRow[], first: boolean) => Promise<void>,
) {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows } = await GscService.getPerformance({
      projectId,
      ...range,
      // The archive applies its own Pacific Time floor (fetchPeriod).
      exactDates: true,
      dimensions,
      rowLimit: GSC_PAGE_SIZE,
      startRow: total,
      type: "web",
      dataState: "all",
    });
    await write(
      rows.map((row) => ({ ...row, keys: row.keys ?? [] })),
      page === 0,
    );
    total += rows.length;
    if (rows.length < GSC_PAGE_SIZE) return { rows: total, truncated: false };
  }
  return { rows: total, truncated: true };
}

function gscMetrics(row: GscRow) {
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  };
}

function fetchGsc(
  projectId: string,
  fetch: ArchiveFetch,
  range: { startDate: string; endDate: string },
) {
  const days = { from: range.startDate, to: range.endDate };
  switch (fetch.source) {
    case "gsc_site":
      return eachGscPage(projectId, range, ["date", "device"], (rows, first) =>
        SearchArchiveRepository.upsertGscDailySite(
          projectId,
          rows.map((row) => ({
            date: row.keys[0],
            device: row.keys[1],
            ...gscMetrics(row),
          })),
          first ? days : undefined,
        ),
      );
    case "gsc_page":
      return eachGscPage(projectId, range, ["date", "page"], (rows, first) =>
        SearchArchiveRepository.upsertGscDailyPage(
          projectId,
          rows.map((row) => ({
            date: row.keys[0],
            page: row.keys[1],
            ...gscMetrics(row),
          })),
          first ? days : undefined,
        ),
      );
    default:
      return eachGscPage(projectId, range, ["query", "page"], (rows, first) =>
        SearchArchiveRepository.upsertGscMonthlyQueryPage(
          projectId,
          rows.map((row) => ({
            month: fetch.month,
            query: row.keys[0],
            page: row.keys[1],
            ...gscMetrics(row),
          })),
          first ? { from: fetch.month, to: fetch.month } : undefined,
        ),
      );
  }
}

const organicFilter = {
  filter: {
    fieldName: "sessionDefaultChannelGroup",
    stringFilter: { matchType: "EXACT", value: "Organic Search" },
  },
};

/** GA4 reports dates as YYYYMMDD. */
function ga4Date(value: string | number | null): string {
  const text = String(value);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

const metric = (value: string | number | null) =>
  typeof value === "number" ? Math.round(value) : 0;

type Ga4Row = Record<string, string | number | null>;

/** Every page of a GA4 report, handed to `write` page by page. */
async function eachGa4Page(
  projectId: string,
  fetch: ArchiveFetch,
  shape: Pick<
    Ga4RunReportRequest,
    "dimensions" | "metrics" | "dimensionFilter"
  >,
  write: (rows: Ga4Row[], first: boolean) => Promise<void>,
) {
  const connection = await Ga4ConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google Analytics is not connected for this project.",
    );
  }
  const client = createGa4DataClient({
    userId: connection.connectedByUserId,
    ga4AccountId: connection.ga4AccountId,
    propertyId: connection.propertyId,
  });
  let total = 0;
  let quota: Ga4Quota | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const request: Ga4RunReportRequest = {
        dateRanges: [{ startDate: fetch.startDate, endDate: fetch.endDate }],
        ...shape,
        offset: String(total),
        limit: String(GA4_PAGE_SIZE),
        orderBys: shape.dimensions.map(({ name }) => ({
          dimension: { dimensionName: name },
        })),
        keepEmptyRows: false,
        returnPropertyQuota: true,
      };
      const report = normalizeGa4Response(
        await client.runReport(request),
        request,
      );
      quota = report.quota ?? quota;
      await write(report.rows, page === 0);
      total += report.rows.length;
      if (report.rows.length === 0 || total >= report.totalRowCount) {
        return { rows: total, truncated: false, quota };
      }
    }
  } catch (error) {
    if (
      error instanceof Ga4DataApiError &&
      error.upstreamReason === "SERVICE_DISABLED"
    ) {
      throw new ArchiveSourceUnavailableError(
        "The Google Analytics Data API is not enabled for this OAuth application.",
      );
    }
    mapGa4ReportError(error);
  }
  return { rows: total, truncated: true, quota };
}

type Ga4Day = {
  date: string;
  sessions: number;
  organicSessions: number;
  keyEvents: number;
  organicKeyEvents: number;
};

async function fetchGa4(projectId: string, fetch: ArchiveFetch) {
  const days = { from: fetch.startDate, to: fetch.endDate };
  if (fetch.source === "ga4_site") {
    // One row per day and channel: only the per-day totals are kept.
    const byDate = new Map<string, Ga4Day>();
    const result = await eachGa4Page(
      projectId,
      fetch,
      {
        dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      },
      async (rows) => {
        for (const row of rows) {
          const date = ga4Date(row.date);
          const day = byDate.get(date) ?? {
            date,
            sessions: 0,
            organicSessions: 0,
            keyEvents: 0,
            organicKeyEvents: 0,
          };
          day.sessions += metric(row.sessions);
          day.keyEvents += metric(row.keyEvents);
          if (row.sessionDefaultChannelGroup === "Organic Search") {
            day.organicSessions += metric(row.sessions);
            day.organicKeyEvents += metric(row.keyEvents);
          }
          byDate.set(date, day);
        }
      },
    );
    await SearchArchiveRepository.upsertGa4DailySite(
      projectId,
      [...byDate.values()],
      days,
    );
    return { ...result, rows: byDate.size };
  }
  return eachGa4Page(
    projectId,
    fetch,
    {
      dimensions: [{ name: "date" }, { name: "landingPage" }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: organicFilter,
    },
    (rows, first) =>
      SearchArchiveRepository.upsertGa4DailyPage(
        projectId,
        rows.map((row) => ({
          date: ga4Date(row.date),
          pagePath: String(row.landingPage),
          organicSessions: metric(row.sessions),
        })),
        first ? days : undefined,
      ),
  );
}

/**
 * A pause when either hourly bucket runs low: the property's, or the one this
 * Cloud project shares across every property it reads (the tighter of the
 * two, 14,000 tokens on a standard property).
 */
function pauseFor(quota: Ga4Quota | null | undefined): number {
  const low = [
    quota?.tokensPerHour?.remaining,
    quota?.tokensPerProjectPerHour?.remaining,
  ].some(
    (remaining) => remaining !== undefined && remaining < GA4_LOW_HOURLY_TOKENS,
  );
  return low ? GA4_LOW_QUOTA_PAUSE_SECONDS : 0;
}

/**
 * Fetches one month of one source, replaces the stored days of that window
 * and records how far it got. Safe to repeat.
 *
 * Search Console drops days at 16 months in Pacific Time, and the plan may
 * be hours old, so the floor is checked again here: a daily fetch is clipped
 * to it, and a monthly total whose month starts before it is never written,
 * since it would be missing days for good.
 */
export async function fetchPeriod(
  projectId: string,
  fetch: ArchiveFetch,
  now: Date = new Date(),
): Promise<FetchOutcome> {
  const record = (fetchedThrough: string, rows: number, complete: boolean) =>
    SearchArchiveRepository.recordPeriod({
      projectId,
      source: fetch.source,
      month: fetch.month,
      fetchedThrough,
      complete,
      rowCount: rows,
      fetchedAt: now.toISOString(),
    });

  if (fetch.source === "ga4_site" || fetch.source === "ga4_page") {
    const result = await fetchGa4(projectId, fetch);
    await record(
      coveredThrough(projectId, fetch, fetch.startDate, result.truncated),
      result.rows,
      fetch.complete && !result.truncated,
    );
    return { rows: result.rows, pauseSeconds: pauseFor(result.quota) };
  }

  const floor = archiveFloor(ga4DateInTimeZone(now, GSC_TIME_ZONE));
  if (fetch.source === "gsc_query_page" && `${fetch.month}-01` < floor) {
    return { rows: 0, pauseSeconds: 0 };
  }
  const startDate = fetch.startDate < floor ? floor : fetch.startDate;
  if (startDate > fetch.endDate) {
    // Google no longer has any of these days.
    await record(fetch.endDate, 0, fetch.complete);
    return { rows: 0, pauseSeconds: 0 };
  }
  const result = await fetchGsc(projectId, fetch, {
    startDate,
    endDate: fetch.endDate,
  });
  await record(
    coveredThrough(projectId, fetch, startDate, result.truncated),
    result.rows,
    fetch.complete && !result.truncated,
  );
  return { rows: result.rows, pauseSeconds: 0 };
}

/**
 * The last day the stored rows cover. Google sorts rows by clicks, not date,
 * so a fetch cut off at MAX_PAGES covers no day for sure: it is recorded as
 * ending before its start, and the next run reads the whole window again.
 */
function coveredThrough(
  projectId: string,
  fetch: ArchiveFetch,
  startDate: string,
  truncated: boolean,
): string {
  if (!truncated) return fetch.endDate;
  console.warn(
    `[search-archive] ${projectId} ${fetch.source} ${fetch.month}: stopped after ${MAX_PAGES} pages; the month stays incomplete.`,
  );
  return addDays(startDate, -1);
}
