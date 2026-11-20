import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { addDays } from "@/server/features/search-archive/archivePlan";
import { DailyPulseService } from "./DailyPulseService";

// The daily pulse against what production showed: sites whose data starts
// inside the baseline, pages Google moved between www and the bare host, and
// a site-wide drop no single page shows.

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));

// Search Console's window: Nov 11–17 against Oct 14–Nov 10.
const NOW = new Date("2026-11-20T12:00:00Z");
const BASELINE_START = "2026-10-14";
const RECENT_START = "2026-11-11";

const days = (from: string, count: number) =>
  Array.from({ length: count }, (_, i) => addDays(from, i));

async function siteDay(date: string, clicks: number, impressions = 1_000) {
  await testDb.client.execute({
    sql: `INSERT INTO gsc_daily_site (project_id, date, device, clicks, impressions, ctr, position)
      VALUES ('project', ?, 'MOBILE', ?, ?, 0, 7)`,
    args: [date, clicks, impressions],
  });
}

async function pageDay(
  url: string,
  date: string,
  clicks: number,
  impressions: number,
) {
  await testDb.client.execute({
    sql: `INSERT INTO gsc_daily_page (project_id, date, page, clicks, impressions, ctr, position)
      VALUES ('project', ?, ?, ?, ?, 0, 7)`,
    args: [date, url, clicks, impressions],
  });
}

const pulse = () => DailyPulseService.compute("project", { now: NOW });
const types = async () => (await pulse()).alerts.map((alert) => alert.type);

beforeAll(async () => {
  await testDb.seedProject();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await testDb.client.executeMultiple(`
    DELETE FROM gsc_daily_page;
    DELETE FROM gsc_daily_site;
    DELETE FROM ga4_daily_site;
    DELETE FROM seo_tasks;
    DELETE FROM search_archive_periods;
    INSERT INTO search_archive_periods (project_id, source, month, fetched_through, complete, row_count, fetched_at)
      SELECT 'project', source, month, through, 0, 1, '2026-11-20T00:00:00.000Z'
      FROM (SELECT 'gsc_page' AS source UNION ALL SELECT 'gsc_site' UNION ALL SELECT 'ga4_site')
      CROSS JOIN (SELECT '2025-07' AS month, '2025-07-31' AS through
                  UNION ALL SELECT '2026-10', '2026-10-31'
                  UNION ALL SELECT '2026-11', '2026-11-19');
  `);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("daily pulse coverage", () => {
  it("skips a site whose data starts inside the baseline, though its months were scanned", async () => {
    // Baklava Rehberi: scanned back to 2025-07, data from Nov 2.
    for (const date of days("2026-11-02", 16)) {
      await siteDay(date, 10);
      await pageDay("https://baklava.example/tarif", date, 2, 30);
    }

    const result = await pulse();

    expect(result.gsc.evaluated).toBe(false);
    expect(!result.gsc.evaluated && result.gsc.reason).toContain(
      "starts on 2026-11-02",
    );
    expect(result.alerts).toEqual([]);
  });

  it("does not call a page that first appeared after the baseline began rising", async () => {
    await siteDay("2026-09-01", 0);
    await pageDay("https://a.example/yeni", "2026-10-20", 0, 5);
    await pageDay("https://a.example/yeni", "2026-11-15", 0, 200);
    await pageDay("https://a.example/eski", "2026-09-01", 0, 1);
    await pageDay("https://a.example/eski", "2026-11-15", 0, 200);

    expect((await pulse()).alerts.map((alert) => alert.url)).toEqual([
      "https://a.example/eski",
    ]);
  });
});

describe("www and bare-host addresses", () => {
  // Hava Temizleyiciler: Google moved the pages from the bare host to www.
  async function movedPages() {
    await siteDay("2026-09-01", 0);
    for (const path of ["/", "/filtre"]) {
      await pageDay(`https://hava.example${path}`, BASELINE_START, 40, 400);
      await pageDay(`https://www.hava.example${path}`, RECENT_START, 10, 100);
    }
  }

  it("judges a page across both addresses and reports the move once", async () => {
    await movedPages();

    const { alerts } = await pulse();

    expect(alerts).toEqual([
      expect.objectContaining({
        type: "host_change",
        url: null,
        title: "Adres değişikliği: www ↔ www'siz",
        priority: "medium",
      }),
    ]);
    expect(alerts[0].evidence).toContain(
      "2 sayfa www'siz adresten www'ye taşındı",
    );
  });

  it("keeps one task for the move across runs", async () => {
    await movedPages();

    await DailyPulseService.recordAlerts("project", NOW);
    const second = await DailyPulseService.recordAlerts("project", NOW);

    expect(second).toMatchObject({ created: 0, updated: 1 });
  });

  it("matches a first-version task on the other address, and ignores its dropped false alerts", async () => {
    await siteDay("2026-09-01", 0);
    await pageDay("https://www.hava.example/a", BASELINE_START, 0, 80);
    await pageDay("https://www.hava.example/b", BASELINE_START, 0, 80);
    await testDb.client.executeMultiple(`
      INSERT INTO seo_tasks (id, project_id, code, title, evidence, status, status_changed_at)
        VALUES ('open', 'project', 'N-20261119-1', 'x', '[nabız: page_disappeared] eski', 'proposed', '2026-11-19T00:00:00.000Z'),
               ('dropped', 'project', 'N-20261119-2', 'y', '[nabız: page_disappeared] eski', 'dropped', '2026-11-19T00:00:00.000Z');
      INSERT INTO seo_task_urls (task_id, url, sort_order)
        VALUES ('open', 'https://hava.example/a', 0), ('open', 'https://hava.example/notlar', 1),
               ('dropped', 'https://hava.example/b', 0);
    `);

    const result = await DailyPulseService.recordAlerts("project", NOW);

    expect(result).toMatchObject({ updated: 1, created: 1, skipped: 0 });
    const urls = await testDb.client.execute(
      "SELECT url FROM seo_task_urls WHERE task_id = 'open' ORDER BY sort_order",
    );
    // The page moved to www; the URL the owner added stays.
    expect(urls.rows).toEqual([
      { url: "https://www.hava.example/a" },
      { url: "https://hava.example/notlar" },
    ]);
  });
});

describe("site clicks drop", () => {
  it("fires for the Hava Temizleyiciler pattern", async () => {
    // 46–50 clicks a day, then 5–14 a day.
    for (const [i, date] of days(BASELINE_START, 28).entries()) {
      await siteDay(date, 46 + (i % 5), 1_281);
    }
    for (const [i, date] of days(RECENT_START, 7).entries()) {
      await siteDay(date, [5, 14, 9, 7, 12, 6, 10][i], 450);
    }

    const [alert, ...rest] = (await pulse()).alerts;

    expect(rest).toEqual([]);
    expect(alert).toMatchObject({
      type: "site_clicks_drop",
      url: null,
      priority: "high",
      recent: 63,
      title: "Site tıklama düşüşü: site geneli",
    });
    expect(alert.evidence.startsWith("[nabız/2: site_clicks_drop]")).toBe(true);
  });

  // Expected recent clicks = baseline / 4.
  it.each([
    ["fell exactly 40% (200 → 30)", 200, 30, true],
    ["fell 38% (200 → 31)", 200, 31, false],
    ["49 baseline clicks, below the minimum", 49, 0, false],
  ])("%s", async (_name, baseline, recent, fires) => {
    await siteDay(BASELINE_START, baseline);
    await siteDay(RECENT_START, recent);
    expect(await types()).toEqual(fires ? ["site_clicks_drop"] : []);
  });
});
