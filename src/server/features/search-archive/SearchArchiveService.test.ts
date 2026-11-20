import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4DataApiError } from "@/server/lib/ga4Errors";
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
      getGscConnection: vi.fn(),
      getProjectForOrganization: vi.fn(),
      createWorkflow: vi.fn(),
      workflowStatus: vi.fn(),
      terminateWorkflow: vi.fn(),
    },
  };
});

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    SEARCH_ARCHIVE_WORKFLOW: {
      create: mocks.createWorkflow,
      get: async () => ({
        status: mocks.workflowStatus,
        terminate: mocks.terminateWorkflow,
      }),
    },
  },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: mocks.getGscConnection },
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

const NOW = new Date("2026-11-20T12:00:00Z"); // Nov 20 in UTC and in PT

const novemberPages = {
  source: "gsc_page" as const,
  month: "2026-11",
  startDate: "2026-11-01",
  endDate: "2026-11-19",
  complete: false,
};

const ga4SiteResponse = (rows: string[][], tokensLeft = 30_000) => ({
  dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
  metricHeaders: [{ name: "sessions" }, { name: "keyEvents" }],
  rows: rows.map(([date, channel, sessions, keyEvents]) => ({
    dimensionValues: [{ value: date }, { value: channel }],
    metricValues: [{ value: sessions }, { value: keyEvents }],
  })),
  rowCount: rows.length,
  propertyQuota: {
    tokensPerHour: { consumed: 40_000 - tokensLeft, remaining: tokensLeft },
  },
});

beforeAll(async () => {
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO projects (id, organization_id, name) VALUES ('other', 'organization', 'Other');
  `);
});

beforeEach(async () => {
  await testDb.client.executeMultiple(`
    DELETE FROM gsc_daily_page;
    DELETE FROM gsc_daily_site;
    DELETE FROM gsc_monthly_query_page;
    DELETE FROM ga4_daily_site;
    DELETE FROM search_archive_periods;
    DELETE FROM search_archive_runs;
  `);
  mocks.getPerformance.mockResolvedValue({ rows: [] });
  mocks.getGscConnection.mockResolvedValue({ siteUrl: "sc-domain:a.com" });
  mocks.getGa4Connection.mockResolvedValue({
    connectedByUserId: "user",
    ga4AccountId: "account",
    propertyId: "properties/1",
    propertyTimeZone: "Europe/Istanbul",
  });
  mocks.getProjectForOrganization.mockImplementation(
    async (_organizationId: string, projectId: string) =>
      projectId === "project" ? { id: projectId } : null,
  );
  mocks.createWorkflow.mockResolvedValue(undefined);
  mocks.workflowStatus.mockResolvedValue({ status: "running" });
});

const count = async (table: string) =>
  (await testDb.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n;

const periods = async () =>
  (
    await testDb.client.execute(
      "SELECT source, month, fetched_through, complete, row_count FROM search_archive_periods",
    )
  ).rows;

describe("search archive fetch", () => {
  it("replaces a re-fetched window: revised rows update, dropped rows go", async () => {
    mocks.getPerformance.mockResolvedValueOnce({
      rows: [
        gscRow(["2026-11-18", "https://a.com/"], 3, 100, 8),
        gscRow(["2026-11-19", "https://a.com/"], 1, 40, 9),
        gscRow(["2026-11-19", "https://a.com/gone"], 1, 10, 30),
      ],
    });
    await SearchArchiveService.fetchPeriod("project", novemberPages, NOW);
    // Google revised the 19th and no longer reports one page.
    mocks.getPerformance.mockResolvedValueOnce({
      rows: [
        gscRow(["2026-11-18", "https://a.com/"], 3, 100, 8),
        gscRow(["2026-11-19", "https://a.com/"], 5, 120, 7),
      ],
    });
    await SearchArchiveService.fetchPeriod("project", novemberPages, NOW);

    expect(await count("gsc_daily_page")).toBe(2);
    const revised = await testDb.client.execute(
      "SELECT clicks, impressions FROM gsc_daily_page WHERE date = '2026-11-19'",
    );
    expect(revised.rows).toEqual([
      expect.objectContaining({ clicks: 5, impressions: 120 }),
    ]);
    expect(await periods()).toEqual([
      expect.objectContaining({
        fetched_through: "2026-11-19",
        complete: 0,
        row_count: 2,
      }),
    ]);
  });

  it("pages through Google's row limit", async () => {
    const fullPage = Array.from({ length: 25_000 }, (_, index) =>
      gscRow(["2026-11-01", `https://a.com/${index}`], 1, 10, 5),
    );
    mocks.getPerformance
      .mockResolvedValueOnce({ rows: fullPage })
      .mockResolvedValueOnce({
        rows: [gscRow(["2026-11-02", "https://a.com/last"], 1, 10, 5)],
      });
    const result = await SearchArchiveService.fetchPeriod(
      "project",
      novemberPages,
      NOW,
    );

    expect(result.rows).toBe(25_001);
    expect(mocks.getPerformance).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startRow: 0 }),
    );
    expect(mocks.getPerformance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startRow: 25_000 }),
    );
    expect(await count("gsc_daily_page")).toBe(25_001);
  });

  describe("Search Console's 16-month floor, in Pacific Time", () => {
    // Planned on Nov 1 (Pacific), when Google still had all of July 2025.
    const july = {
      source: "gsc_query_page" as const,
      month: "2025-07",
      startDate: "2025-07-01",
      endDate: "2025-07-31",
      complete: true,
    };

    it("still writes the month at 03:00 UTC on Nov 2, which is Nov 1 in Pacific Time", async () => {
      await SearchArchiveService.fetchPeriod(
        "project",
        july,
        new Date("2026-11-02T03:00:00Z"),
      );
      expect(mocks.getPerformance).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2025-07-01",
          endDate: "2025-07-31",
          exactDates: true,
        }),
      );
      expect(await periods()).toEqual([
        expect.objectContaining({ month: "2025-07", complete: 1 }),
      ]);
    });

    it("skips the month once July 1 has left Google (09:00 UTC on Nov 2)", async () => {
      await SearchArchiveService.fetchPeriod(
        "project",
        july,
        new Date("2026-11-02T09:00:00Z"),
      );
      expect(mocks.getPerformance).not.toHaveBeenCalled();
      expect(await periods()).toEqual([]);
    });

    it("clips a daily fetch to the floor, and skips days Google no longer has", async () => {
      const at = new Date("2026-11-02T09:00:00Z");
      await SearchArchiveService.fetchPeriod(
        "project",
        { ...july, source: "gsc_site" },
        at,
      );
      expect(mocks.getPerformance).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: "2025-07-02" }),
      );

      mocks.getPerformance.mockClear();
      await SearchArchiveService.fetchPeriod(
        "project",
        { ...july, source: "gsc_page", endDate: "2025-07-01" },
        at,
      );
      expect(mocks.getPerformance).not.toHaveBeenCalled();
    });
  });

  it("splits GA4 sessions into all and organic per day, and pauses on a low quota", async () => {
    mocks.runReport.mockResolvedValueOnce(
      ga4SiteResponse(
        [
          ["20261118", "Organic Search", "30", "2"],
          ["20261118", "Direct", "10", "1"],
        ],
        500,
      ),
    );
    const result = await SearchArchiveService.fetchPeriod(
      "project",
      { ...novemberPages, source: "ga4_site" },
      NOW,
    );
    expect(result.pauseSeconds).toBeGreaterThan(0);
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

  it("pauses when the Cloud project's hourly GA4 bucket runs low", async () => {
    mocks.runReport.mockResolvedValueOnce({
      ...ga4SiteResponse([]),
      propertyQuota: {
        tokensPerHour: { consumed: 0, remaining: 40_000 },
        tokensPerProjectPerHour: { consumed: 13_000, remaining: 1_000 },
      },
    });
    const result = await SearchArchiveService.fetchPeriod(
      "project",
      { ...novemberPages, source: "ga4_site" },
      NOW,
    );
    expect(result.pauseSeconds).toBeGreaterThan(0);
  });

  it("treats a switched-off GA4 API as permanent", async () => {
    mocks.runReport.mockRejectedValueOnce(
      new Ga4DataApiError(403, "denied", null, "SERVICE_DISABLED"),
    );
    const failure = await SearchArchiveService.fetchPeriod(
      "project",
      { ...novemberPages, source: "ga4_page" },
      NOW,
    ).catch((error: unknown) => error);
    expect(isPermanentArchiveError(failure)).toBe(true);
  });
});

describe("search archive runs", () => {
  it("starts one workflow when two starts race", async () => {
    const results = await Promise.all([
      SearchArchiveService.start("project", "backfill"),
      SearchArchiveService.start("project", "backfill"),
    ]);
    expect(results.filter((result) => result.started)).toHaveLength(1);
    expect(mocks.createWorkflow).toHaveBeenCalledTimes(1);
  });

  it("settles a run whose workflow died, and lets a new one start", async () => {
    await testDb.client.execute(`INSERT INTO search_archive_runs
      (project_id, run_id, mode, status, started_at)
      VALUES ('project', 'dead', 'backfill', 'running', '2026-11-20T00:00:00.000Z')`);
    mocks.workflowStatus.mockResolvedValue({ status: "errored" });

    const { run } = await SearchArchiveService.getStatus("project");
    expect(run).toMatchObject({ runId: "dead", status: "failed" });
    expect(mocks.terminateWorkflow).toHaveBeenCalled();

    const started = await SearchArchiveService.start("project", "incremental");
    expect(started).toMatchObject({
      started: true,
      run: { status: "running", mode: "incremental" },
    });
  });

  it("keeps a healthy run that has been waiting out quotas for 13 hours", async () => {
    const startedAt = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    await testDb.client.execute({
      sql: `INSERT INTO search_archive_runs (project_id, run_id, mode, status, started_at)
        VALUES ('project', 'sleeping', 'backfill', 'running', ?)`,
      args: [startedAt],
    });
    mocks.workflowStatus.mockResolvedValue({ status: "waiting" });

    const { run } = await SearchArchiveService.getStatus("project");
    expect(run).toMatchObject({ runId: "sleeping", status: "running" });
    expect(mocks.terminateWorkflow).not.toHaveBeenCalled();
  });
});
