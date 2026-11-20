import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getDailyPulseTool } from "@/server/mcp/tools/daily-pulse-tools";
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import { DailyPulseService } from "./DailyPulseService";

const { testDb, getProjectForOrganization } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    getProjectForOrganization: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization },
}));

// Nov 20 in Pacific Time and Istanbul. The latest complete Search Console day
// is Nov 17, so the recent window is Nov 11–17 and the baseline Oct 14–Nov 10.
// Analytics lags 2 days in Istanbul: Nov 12–18 against Oct 15–Nov 11.
const NOW = new Date("2026-11-20T12:00:00Z");
const BASELINE_DAY = "2026-10-14";
const RECENT_DAY = "2026-11-17";
const SITE = "https://a.com";

const context = makeToolContext({ organizationId: "organization" });

/** One page's totals: a baseline row and, unless empty, a recent row. */
async function page(
  path: string,
  baseline: { clicks: number; impressions: number },
  recent: { clicks: number; impressions: number } | null,
  projectId = "project",
) {
  await testDb.client.execute({
    sql: `INSERT INTO gsc_daily_page (project_id, date, page, clicks, impressions, ctr, position)
      VALUES (?, ?, ?, ?, ?, 0, 5)`,
    args: [
      projectId,
      BASELINE_DAY,
      `${SITE}${path}`,
      baseline.clicks,
      baseline.impressions,
    ],
  });
  if (recent) {
    await testDb.client.execute({
      sql: `INSERT INTO gsc_daily_page (project_id, date, page, clicks, impressions, ctr, position)
        VALUES (?, ?, ?, ?, ?, 0, 5)`,
      args: [
        projectId,
        RECENT_DAY,
        `${SITE}${path}`,
        recent.clicks,
        recent.impressions,
      ],
    });
  }
}

async function organicSessions(baseline: number, recent: number) {
  await testDb.client.execute({
    sql: `INSERT INTO ga4_daily_site (project_id, date, sessions, organic_sessions, key_events, organic_key_events)
      VALUES ('project', ?, 0, ?, 0, 0), ('project', ?, 0, ?, 0, 0)`,
    args: ["2026-10-15", baseline, "2026-11-18", recent],
  });
}

const pulse = async () => DailyPulseService.compute("project", { now: NOW });

const alertsOf = async () =>
  (await pulse()).alerts.map((alert) => `${alert.type} ${alert.url ?? ""}`);

const tasks = async () =>
  (
    await testDb.client.execute(
      `SELECT t.code, t.title, t.status, t.priority, t.size, t.evidence, u.url
         FROM seo_tasks t LEFT JOIN seo_task_urls u ON u.task_id = t.id
         ORDER BY t.code`,
    )
  ).rows;

beforeAll(async () => {
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO organization (id, name, slug, created_at)
      VALUES ('other-org', 'Other', 'other-org', 0);
    INSERT INTO projects (id, organization_id, name) VALUES ('other', 'other-org', 'Other');
  `);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await testDb.client.executeMultiple(`
    DELETE FROM gsc_daily_page;
    DELETE FROM ga4_daily_site;
    DELETE FROM seo_tasks;
    DELETE FROM search_archive_periods;
    INSERT INTO search_archive_periods (project_id, source, month, fetched_through, complete, row_count, fetched_at)
      VALUES ('project', 'gsc_page', '2026-10', '2026-10-31', 1, 1, '2026-11-05T00:00:00.000Z'),
             ('project', 'gsc_page', '2026-11', '2026-11-19', 0, 1, '2026-11-20T00:00:00.000Z'),
             ('project', 'ga4_site', '2026-10', '2026-10-31', 1, 1, '2026-11-05T00:00:00.000Z'),
             ('project', 'ga4_site', '2026-11', '2026-11-19', 0, 1, '2026-11-20T00:00:00.000Z');
  `);
  getProjectForOrganization.mockImplementation(
    async (organizationId: string, projectId: string) =>
      organizationId === "organization" && projectId === "project"
        ? { id: projectId, organizationId }
        : null,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("daily pulse rules", () => {
  // Expected recent value = baseline / 4 (28 days scaled to 7).
  it.each([
    ["clicks fell exactly 50% (40 → 5)", 40, 5, ["traffic_drop"]],
    ["clicks fell 40% (40 → 6)", 40, 6, []],
    ["20 baseline clicks, the minimum (20 → 2)", 20, 2, ["traffic_drop"]],
    ["19 baseline clicks, below the minimum (19 → 0)", 19, 0, []],
  ])("traffic drop: %s", async (_name, baselineClicks, recentClicks, types) => {
    await page(
      "/sayfa",
      { clicks: baselineClicks, impressions: 400 },
      { clicks: recentClicks, impressions: 100 },
    );
    expect((await pulse()).alerts.map((alert) => alert.type)).toEqual(types);
  });

  it("page disappeared: 50 baseline impressions and none since, not also a drop", async () => {
    await page("/tursucular/giresun", { clicks: 30, impressions: 50 }, null);
    await page("/az", { clicks: 0, impressions: 49 }, null);

    const [alert, ...rest] = (await pulse()).alerts;

    expect(rest).toEqual([]);
    expect(alert).toMatchObject({
      type: "page_disappeared",
      url: `${SITE}/tursucular/giresun`,
      title: "Gösterim kesildi: /tursucular/giresun",
      priority: "high",
      recent: 0,
      baseline: 50,
      recentWindow: { start: "2026-11-11", end: "2026-11-17" },
      baselineWindow: { start: "2026-10-14", end: "2026-11-10" },
    });
    expect(alert.evidence).toContain(
      "Son 7 gün (2026-11-11 – 2026-11-17): 0 gösterim",
    );
    expect(alert.evidence).toContain(
      "Önceki 28 gün (2026-10-14 – 2026-11-10): 50 gösterim",
    );
  });

  it.each([
    ["new page reaching 100 impressions", 0, 100, true],
    ["new page at 99 impressions", 0, 99, false],
    ["exactly +100% (200 → 100)", 200, 100, true],
    ["just under +100% (204 → 101)", 204, 101, false],
  ])("rising page: %s", async (_name, baseline, recent, fires) => {
    await page(
      "/yeni",
      { clicks: 0, impressions: baseline },
      { clicks: 0, impressions: recent },
    );
    expect(await alertsOf()).toEqual(fires ? [`rising_page ${SITE}/yeni`] : []);
  });

  it.each([
    ["fell exactly 40% (100 → 15)", 100, 15, true],
    ["fell 36% (100 → 16)", 100, 16, false],
    ["50 baseline sessions, the minimum (50 → 7)", 50, 7, true],
    ["49 baseline sessions, below the minimum (49 → 0)", 49, 0, false],
  ])("organic sessions drop: %s", async (_name, baseline, recent, fires) => {
    await organicSessions(baseline, recent);
    const alerts = (await pulse()).alerts;
    expect(alerts.map((alert) => alert.type)).toEqual(
      fires ? ["organic_sessions_drop"] : [],
    );
    if (fires) {
      expect(alerts[0]).toMatchObject({
        title: "Organik oturum düşüşü: site geneli",
        priority: "high",
        url: null,
      });
    }
  });

  it.each([
    [
      "a missing month",
      "DELETE FROM search_archive_periods WHERE source = 'gsc_page' AND month = '2026-10'",
    ],
    [
      "a month read only part way",
      "UPDATE search_archive_periods SET fetched_through = '2026-10-20' WHERE source = 'gsc_page' AND month = '2026-10'",
    ],
    [
      "an archive that stopped before the window's end",
      "UPDATE search_archive_periods SET fetched_through = '2026-11-16' WHERE source = 'gsc_page' AND month = '2026-11'",
    ],
  ])("skips Search Console with %s", async (_name, change) => {
    await testDb.client.execute(change);
    await page("/tursucular/giresun", { clicks: 30, impressions: 80 }, null);

    const result = await pulse();

    expect(result.gsc).toMatchObject({ evaluated: false });
    expect(result.alerts).toEqual([]);
  });

  it("skips stale Analytics data while judging fresh Search Console data", async () => {
    await testDb.client.execute(
      "UPDATE search_archive_periods SET fetched_through = '2026-11-10' WHERE source = 'ga4_site' AND month = '2026-11'",
    );
    await organicSessions(100, 0);
    await page("/tursucular/giresun", { clicks: 30, impressions: 80 }, null);

    const result = await pulse();

    expect(result.ga4).toMatchObject({ evaluated: false });
    expect(result.alerts.map((alert) => alert.type)).toEqual([
      "page_disappeared",
    ]);
  });

  it("keeps the 10 largest alerts per rule", async () => {
    for (let i = 1; i <= 11; i++) {
      await page(`/p${i}`, { clicks: 0, impressions: 50 + i }, null);
    }
    const alerts = (await pulse()).alerts;
    expect(alerts).toHaveLength(10);
    expect(alerts.map((alert) => alert.baseline)).not.toContain(51);
  });

  it("titles a page by its decoded path, cut to the title limit", async () => {
    await page("/t%C3%BCr%C5%9Fu", { clicks: 0, impressions: 60 }, null);
    await page(`/${"a".repeat(400)}`, { clicks: 0, impressions: 50 }, null);

    const [short, long] = (await pulse()).alerts;

    expect(short.title).toBe("Gösterim kesildi: /türşu");
    expect(long.title).toHaveLength(300);
    expect(long.title.startsWith("Gösterim kesildi: /aaa")).toBe(true);
  });
});

describe("daily pulse tasks", () => {
  it("writes each alert once as a proposed task and only refreshes its evidence later", async () => {
    await page("/tursucular/giresun", { clicks: 30, impressions: 80 }, null);
    await page(
      "/yeni",
      { clicks: 0, impressions: 0 },
      { clicks: 0, impressions: 150 },
    );

    await DailyPulseService.recordAlerts("project", NOW);

    expect(await tasks()).toEqual([
      expect.objectContaining({
        code: "N-20261120-1",
        title: "Gösterim kesildi: /tursucular/giresun",
        status: "proposed",
        priority: "high",
        size: "S",
        url: `${SITE}/tursucular/giresun`,
      }),
      expect.objectContaining({
        code: "N-20261120-2",
        title: "Gösterim artışı: /yeni",
        priority: "medium",
        url: `${SITE}/yeni`,
      }),
    ]);

    // The owner picks one up; a later run the same day with more data and a
    // new alert updates, and numbers the new one after the others.
    await testDb.client.execute(
      "UPDATE seo_tasks SET status = 'selected' WHERE code = 'N-20261120-1'",
    );
    await testDb.client.execute(
      `UPDATE gsc_daily_page SET impressions = 90 WHERE page = '${SITE}/tursucular/giresun'`,
    );
    await page(
      "/dusen",
      { clicks: 40, impressions: 400 },
      { clicks: 2, impressions: 50 },
    );

    const result = await DailyPulseService.recordAlerts("project", NOW);

    expect(result).toMatchObject({ alerts: 3, created: 1, updated: 2 });
    const rows = await tasks();
    expect(rows.map((row) => row.code)).toEqual([
      "N-20261120-1",
      "N-20261120-2",
      "N-20261120-3",
    ]);
    expect(rows[0]).toMatchObject({ status: "selected" });
    expect(rows[0].evidence).toEqual(expect.stringContaining("90 gösterim"));
    expect(rows[2]).toMatchObject({ title: "Trafik düşüşü: /dusen" });
  });

  it("does not propose again an alert the owner closed within 28 days", async () => {
    await page("/tursucular/giresun", { clicks: 30, impressions: 80 }, null);
    await DailyPulseService.recordAlerts("project", NOW);
    await testDb.client.execute(
      `UPDATE seo_tasks SET status = 'dropped', status_changed_at = '2026-11-19T00:00:00.000Z'`,
    );

    const result = await DailyPulseService.recordAlerts("project", NOW);

    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(await tasks()).toHaveLength(1);
  });

  it("proposes an alert again once it was closed more than 28 days ago", async () => {
    await page("/tursucular/giresun", { clicks: 30, impressions: 80 }, null);
    await DailyPulseService.recordAlerts("project", NOW);
    await testDb.client.execute(
      `UPDATE seo_tasks SET status = 'done', status_changed_at = '2026-10-22T00:00:00.000Z'`,
    );

    const result = await DailyPulseService.recordAlerts("project", NOW);

    expect(result).toMatchObject({ created: 1, skipped: 0 });
    expect(await tasks()).toHaveLength(2);
  });

  it("matches the site-wide organic alert, and an alert whose title was edited", async () => {
    await organicSessions(100, 0);
    await DailyPulseService.recordAlerts("project", NOW);
    await testDb.client.execute(
      "UPDATE seo_tasks SET title = 'Organik trafik neden düştü?'",
    );

    const result = await DailyPulseService.recordAlerts("project", NOW);

    expect(result).toMatchObject({ created: 0, updated: 1, errors: 0 });
    expect(await tasks()).toHaveLength(1);
  });
});

describe("get_daily_pulse", () => {
  it("reads only the authorized project's archive", async () => {
    await page("/tursucular/giresun", { clicks: 30, impressions: 80 }, null);
    await page("/baska", { clicks: 30, impressions: 80 }, null, "other");

    const result = await getDailyPulseTool.handler(
      { projectId: "project", date: "2026-11-17" },
      context,
    );

    expect(result.structuredContent.alerts.map((alert) => alert.url)).toEqual([
      `${SITE}/tursucular/giresun`,
    ]);
    await expect(
      getDailyPulseTool.handler({ projectId: "other" }, context),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a date that does not exist", () => {
    const { date } = getDailyPulseTool.config.inputSchema;
    expect(date.safeParse("2026-02-28").success).toBe(true);
    expect(date.safeParse("2026-02-30").success).toBe(false);
  });
});
