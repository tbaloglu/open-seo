import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { normalizeGa4Response } from "@/server/features/ga4/services/Ga4ReportNormalization";
import { mapGa4ReportError } from "@/server/features/ga4/services/Ga4ReportingService";
import { GscService } from "@/server/features/gsc/services/GscService";
import type { GscDimension } from "@/server/features/gsc/searchAnalytics";
import { AppError } from "@/server/lib/errors";
import {
  createGa4DataClient,
  type Ga4RunReportRequest,
} from "@/server/lib/ga4Client";
import type { ArchiveFetch } from "./archivePlan";
import { SearchArchiveRepository } from "./SearchArchiveRepository";

// Fetches one month of one source for the search archive. It reads through
// the same service and client as the live tools (their token, gateway and
// error handling), one request at a time, and pages through Google's row
// limits.

/** Google's maximum Search Analytics page. */
const GSC_PAGE_SIZE = 25_000;
const GA4_PAGE_SIZE = 100_000;
/** A runaway guard: 40 pages of 25,000 rows is a million rows per month. */
const MAX_PAGES = 40;

/** Every page of a Search Analytics query, written page by page. */
async function eachGscPage(
  projectId: string,
  fetch: ArchiveFetch,
  dimensions: GscDimension[],
  write: (
    rows: Array<{
      keys: string[];
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>,
  ) => Promise<void>,
): Promise<number> {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows } = await GscService.getPerformance({
      projectId,
      startDate: fetch.startDate,
      endDate: fetch.endDate,
      dimensions,
      rowLimit: GSC_PAGE_SIZE,
      startRow: total,
      type: "web",
      dataState: "all",
    });
    await write(rows.map((row) => ({ ...row, keys: row.keys ?? [] })));
    total += rows.length;
    if (rows.length < GSC_PAGE_SIZE) break;
  }
  return total;
}

function gscMetrics(row: {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}) {
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  };
}

async function fetchGsc(projectId: string, fetch: ArchiveFetch) {
  switch (fetch.source) {
    case "gsc_site":
      return eachGscPage(projectId, fetch, ["date", "device"], (rows) =>
        SearchArchiveRepository.upsertGscDailySite(
          projectId,
          rows.map((row) => ({
            date: row.keys[0],
            device: row.keys[1],
            ...gscMetrics(row),
          })),
        ),
      );
    case "gsc_page":
      return eachGscPage(projectId, fetch, ["date", "page"], (rows) =>
        SearchArchiveRepository.upsertGscDailyPage(
          projectId,
          rows.map((row) => ({
            date: row.keys[0],
            page: row.keys[1],
            ...gscMetrics(row),
          })),
        ),
      );
    default:
      return eachGscPage(projectId, fetch, ["query", "page"], (rows) =>
        SearchArchiveRepository.upsertGscMonthlyQueryPage(
          projectId,
          rows.map((row) => ({
            month: fetch.month,
            query: row.keys[0],
            page: row.keys[1],
            ...gscMetrics(row),
          })),
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

async function runGa4Report(
  projectId: string,
  fetch: ArchiveFetch,
  shape: Pick<
    Ga4RunReportRequest,
    "dimensions" | "metrics" | "dimensionFilter"
  >,
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
  const rows: Array<Record<string, string | number | null>> = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const request: Ga4RunReportRequest = {
        dateRanges: [{ startDate: fetch.startDate, endDate: fetch.endDate }],
        ...shape,
        offset: String(rows.length),
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
      rows.push(...report.rows);
      if (report.rows.length === 0 || rows.length >= report.totalRowCount)
        break;
    }
  } catch (error) {
    mapGa4ReportError(error);
  }
  return rows;
}

async function fetchGa4(projectId: string, fetch: ArchiveFetch) {
  if (fetch.source === "ga4_site") {
    const rows = await runGa4Report(projectId, fetch, {
      dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "keyEvents" }],
    });
    const byDate = new Map<
      string,
      {
        date: string;
        sessions: number;
        organicSessions: number;
        keyEvents: number;
        organicKeyEvents: number;
      }
    >();
    for (const row of rows) {
      const date = ga4Date(row.date);
      const day = byDate.get(date) ?? {
        date,
        sessions: 0,
        organicSessions: 0,
        keyEvents: 0,
        organicKeyEvents: 0,
      };
      const organic = row.sessionDefaultChannelGroup === "Organic Search";
      day.sessions += metric(row.sessions);
      day.keyEvents += metric(row.keyEvents);
      if (organic) {
        day.organicSessions += metric(row.sessions);
        day.organicKeyEvents += metric(row.keyEvents);
      }
      byDate.set(date, day);
    }
    await SearchArchiveRepository.upsertGa4DailySite(projectId, [
      ...byDate.values(),
    ]);
    return byDate.size;
  }
  const rows = await runGa4Report(projectId, fetch, {
    dimensions: [{ name: "date" }, { name: "landingPage" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: organicFilter,
  });
  await SearchArchiveRepository.upsertGa4DailyPage(
    projectId,
    rows.map((row) => ({
      date: ga4Date(row.date),
      pagePath: String(row.landingPage),
      organicSessions: metric(row.sessions),
    })),
  );
  return rows.length;
}

/**
 * Fetches one month of one source, upserts it and records how far it got.
 * Safe to repeat: the same keys are written again.
 */
export async function fetchPeriod(
  projectId: string,
  fetch: ArchiveFetch,
): Promise<number> {
  const rowCount = fetch.source.startsWith("gsc_")
    ? await fetchGsc(projectId, fetch)
    : await fetchGa4(projectId, fetch);
  await SearchArchiveRepository.recordPeriod({
    projectId,
    source: fetch.source,
    month: fetch.month,
    fetchedThrough: fetch.endDate,
    complete: fetch.complete,
    rowCount,
    fetchedAt: new Date().toISOString(),
  });
  return rowCount;
}
