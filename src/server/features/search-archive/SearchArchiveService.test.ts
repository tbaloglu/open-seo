import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getArchivedSearchPerformanceTool } from "@/server/mcp/tools/search-archive-tools";
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { GscApiError, GscTokenError } from "@/server/lib/gscErrors";
import { isPermanentArchiveError } from "./archiveFetch";
import { SearchArchiveService } from "./SearchArchiveService";

const { testDb, mocks } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    mocks: {
      getPerformance: vi.fn(),
      runReport: vi.fn(),
      getGa4Connection: vi.fn(),
      getProjectForOrganization: vi.fn(),
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.getGa4Connection },
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4DataClient: () => ({ runReport: mocks.runReport }),
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const gscRow = (
  keys: string[],
  clicks: number,
  impressions: number,
  position: number,
) => ({
  keys,
  clicks,
  impressions,
  ctr: clicks / impressions,
  position,
});

const novemberPages = {
  source: "gsc_page" as const,
  month: "2026-11",
  startDate: "2026-11-01",
  endDate: "2026-11-19",
  complete: false,
};

beforeAll(async () => {
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO projects (id, organization_id, name) VALUES ('other', 'organization', 'Other');
  `);
});

beforeEach(async () => {
  await testDb.client.executeMultiple(`
    DELETE FROM gsc_daily_page;
    DELETE FROM ga4_daily_site;
    DELETE FROM search_archive_periods;
  `);
  mocks.getGa4Connection.mockResolvedValue({
    connectedByUserId: "user",
    ga4AccountId: "account",
    propertyId: "properties/1",
  });
  mocks.getProjectForOrganization.mockImplementation(
    async (_organizationId: string, projectId: string) =>
      projectId === "project" ? { id: projectId } : null,
  );
});

const count = async (table: string) =>
  (await testDb.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n;

describe("search archive", () => {
  it("overwrites a re-fetched period instead of adding rows", async () => {
    mocks.getPerformance.mockResolvedValueOnce({
      rows: [
        gscRow(["2026-11-18", "https://a.com/"], 3, 100, 8),
        gscRow(["2026-11-19", "https://a.com/"], 1, 40, 9),
      ],
    });
    await SearchArchiveService.fetchPeriod("project", novemberPages);
    // Google revised the 19th; the run re-reads it.
    mocks.getPerformance.mockResolvedValueOnce({
      rows: [
        gscRow(["2026-11-18", "https://a.com/"], 3, 100, 8),
        gscRow(["2026-11-19", "https://a.com/"], 5, 120, 7),
      ],
    });
    await SearchArchiveService.fetchPeriod("project", novemberPages);

    expect(await count("gsc_daily_page")).toBe(2);
    const revised = await testDb.client.execute(
      "SELECT clicks, impressions FROM gsc_daily_page WHERE date = '2026-11-19'",
    );
    expect(revised.rows[0]).toMatchObject({ clicks: 5, impressions: 120 });
    const periods = await testDb.client.execute(
      "SELECT fetched_through, complete, row_count FROM search_archive_periods",
    );
    expect(periods.rows).toEqual([
      expect.objectContaining({
        fetched_through: "2026-11-19",
        complete: 0,
        row_count: 2,
      }),
    ]);
  });

  it("splits GA4 sessions into all and organic per day", async () => {
    mocks.runReport.mockResolvedValueOnce({
      dimensionHeaders: [
        { name: "date" },
        { name: "sessionDefaultChannelGroup" },
      ],
      metricHeaders: [{ name: "sessions" }, { name: "keyEvents" }],
      rows: [
        ["Organic Search", "30", "2"],
        ["Direct", "10", "1"],
      ].map(([channel, sessions, keyEvents]) => ({
        dimensionValues: [{ value: "20261118" }, { value: channel }],
        metricValues: [{ value: sessions }, { value: keyEvents }],
      })),
      rowCount: 2,
    });
    await SearchArchiveService.fetchPeriod("project", {
      ...novemberPages,
      source: "ga4_site",
    });
    const rows = await SearchArchiveService.readArchive({
      projectId: "project",
      dataset: "ga4_site",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      limit: 10,
      offset: 0,
    });
    expect(rows).toEqual([
      {
        date: "2026-11-18",
        sessions: 40,
        organicSessions: 30,
        keyEvents: 3,
        organicKeyEvents: 2,
      },
    ]);
  });

  it("reads only the authorized project's archive", async () => {
    await testDb.client.executeMultiple(`
      INSERT INTO gsc_daily_page (project_id, date, page, clicks, impressions, ctr, position)
        VALUES ('project', '2024-01-05', 'https://a.com/', 2, 100, 0.02, 4),
               ('project', '2024-01-06', 'https://a.com/', 2, 300, 0.0067, 8),
               ('other', '2024-01-05', 'https://b.com/', 9, 90, 0.1, 1);
    `);
    const context = makeToolContext({ organizationId: "organization" });
    const result = await getArchivedSearchPerformanceTool.handler(
      {
        projectId: "project",
        dataset: "gsc_pages",
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      },
      context,
    );
    expect(result.structuredContent.rows).toEqual([
      // Position weighted by impressions: (4×100 + 8×300) / 400.
      { page: "https://a.com/", clicks: 4, impressions: 400, position: 7 },
    ]);
    await expect(
      getArchivedSearchPerformanceTool.handler(
        {
          projectId: "other",
          dataset: "gsc_pages",
          startDate: "2024-01-01",
          endDate: "2024-01-31",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("retries quota and outages but not a revoked grant or lost property", () => {
    expect(isPermanentArchiveError(new GscApiError(429, "quota"))).toBe(false);
    expect(isPermanentArchiveError(new GscApiError(503, "down"))).toBe(false);
    expect(
      isPermanentArchiveError(new Ga4ReportError("ga4_quota_exhausted", "q")),
    ).toBe(false);
    expect(isPermanentArchiveError(new GscTokenError("revoked"))).toBe(true);
    expect(isPermanentArchiveError(new GscApiError(403, "denied"))).toBe(true);
    expect(
      isPermanentArchiveError(
        new Ga4ReportError("ga4_property_inaccessible", "gone"),
      ),
    ).toBe(true);
  });
});
