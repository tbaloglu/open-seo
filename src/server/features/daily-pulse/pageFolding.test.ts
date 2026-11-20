import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DailyPulseService } from "./DailyPulseService";

// How the daily pulse folds a page's addresses (www or not, http or https,
// host case) and when it reports a move between www and the bare host.

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
const BEFORE = "2026-09-01";
const BASELINE = "2026-10-14";
const RECENT = "2026-11-15";

async function row(url: string, date: string, impressions: number, clicks = 0) {
  await testDb.client.execute({
    sql: `INSERT INTO gsc_daily_page (project_id, date, page, clicks, impressions, ctr, position)
      VALUES ('project', ?, ?, ?, ?, 0, 7)`,
    args: [date, url, clicks, impressions],
  });
}

const alertsOf = async (date?: string) =>
  (await DailyPulseService.compute("project", { now: NOW, date })).alerts.map(
    (alert) => `${alert.type} ${alert.url ?? ""}`,
  );

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
    DELETE FROM ga4_connections;
    DELETE FROM search_archive_periods;
    INSERT INTO search_archive_periods (project_id, source, month, fetched_through, complete, row_count, fetched_at)
      SELECT 'project', source, month, through, 0, 1, '2026-11-20T00:00:00.000Z'
      FROM (SELECT 'gsc_page' AS source UNION ALL SELECT 'gsc_site' UNION ALL SELECT 'ga4_site')
      CROSS JOIN (SELECT '2026-09' AS month, '2026-09-30' AS through
                  UNION ALL SELECT '2026-10', '2026-10-31'
                  UNION ALL SELECT '2026-11', '2026-11-19');
    INSERT INTO gsc_daily_site (project_id, date, device, clicks, impressions, ctr, position)
      VALUES ('project', '${BEFORE}', 'MOBILE', 0, 1, 0, 9);
  `);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("folding a page's addresses", () => {
  it("rises a page that existed before the baseline on the other host and was quiet in it", async () => {
    await row("http://hava.example/eski", BEFORE, 3);
    await row("https://www.hava.example/eski", RECENT, 200);
    // Never seen before the baseline under any address: new, not rising.
    await row("https://www.hava.example/yeni", "2026-10-20", 1);
    await row("https://www.hava.example/yeni", RECENT, 200);

    expect(await alertsOf()).toEqual([
      "rising_page https://www.hava.example/eski",
    ]);
  });

  it("sums http, https and host case into one page, current where impressions are now", async () => {
    await row("http://HAVA.example/p", BASELINE, 800, 80);
    // One stray impression on the old address, the latest day of all.
    await row("http://hava.example/p", "2026-11-17", 1);
    await row("https://hava.example/p", RECENT, 50, 5);

    const { alerts } = await DailyPulseService.compute("project", { now: NOW });

    expect(alerts).toEqual([
      expect.objectContaining({
        type: "traffic_drop",
        url: "https://hava.example/p",
        recent: 5,
        baseline: 80,
      }),
    ]);
    expect(alerts[0].evidence).toContain("http ve https adresleri birlikte");
  });

  it("keeps other subdomains, query strings and trailing slashes apart", async () => {
    await row("https://m.hava.example/x", BASELINE, 80);
    await row("https://www.hava.example/x", BEFORE, 1);
    await row("https://www.hava.example/x", RECENT, 100);
    await row("https://hava.example/q?sayfa=2", BASELINE, 80);
    await row("https://hava.example/q/", BASELINE, 80);
    await row("https://hava.example/q", BEFORE, 1);
    await row("https://hava.example/q", RECENT, 100);

    expect(new Set(await alertsOf())).toEqual(
      new Set([
        "page_disappeared https://hava.example/q/",
        "page_disappeared https://hava.example/q?sayfa=2",
        "page_disappeared https://m.hava.example/x",
        "rising_page https://hava.example/q",
        "rising_page https://www.hava.example/x",
      ]),
    );
  });

  it("does not judge a day whose data is not final yet", async () => {
    const result = await DailyPulseService.compute("project", {
      now: NOW,
      date: "2026-11-18",
    });
    expect(result.gsc).toMatchObject({ evaluated: false });
  });
});

describe("host change", () => {
  it.each([
    ["80% of the recent impressions on www", 80, 20, true],
    ["79% of the recent impressions on www", 79, 21, false],
  ])("%s", async (_name, onWww, onBare, fires) => {
    await row("https://hava.example/a", BASELINE, 400);
    await row("https://www.hava.example/a", RECENT, onWww);
    await row("https://hava.example/a", RECENT, onBare);

    expect((await alertsOf()).includes("host_change ")).toBe(fires);
  });

  it("ignores pages with fewer than 10 impressions in a window", async () => {
    await row("https://hava.example/a", BASELINE, 9);
    await row("https://www.hava.example/a", RECENT, 100);

    expect(await alertsOf()).not.toContain("host_change ");
  });

  it("names both directions in one alert", async () => {
    await row("https://hava.example/a", BASELINE, 400);
    await row("https://www.hava.example/a", RECENT, 100);
    await row("https://www.hava.example/b", BASELINE, 400);
    await row("https://hava.example/b", RECENT, 100);

    const { alerts } = await DailyPulseService.compute("project", { now: NOW });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].evidence).toContain(
      "1 sayfa www'siz adresten www'ye, 1 sayfa www'den www'siz adrese taşındı",
    );
  });
});

describe("Analytics coverage", () => {
  it("skips Analytics whose data starts inside the baseline, in the property's time zone", async () => {
    // 23:30 UTC: Nov 21 in Istanbul, Nov 20 in Los Angeles. In Los Angeles
    // the window ends Nov 18 and the baseline starts Oct 15.
    const now = new Date("2026-11-20T23:30:00Z");
    await testDb.client.executeMultiple(`
      INSERT INTO ga4_connections (id, project_id, organization_id, property_id, property_display_name,
          property_time_zone, property_currency_code, connected_by_user_id, ga4_account_id)
        VALUES ('ga4', 'project', 'organization', 'properties/1', 'A', 'America/Los_Angeles', 'USD', 'user', 'acc');
      INSERT INTO ga4_daily_site (project_id, date, sessions, organic_sessions, key_events, organic_key_events)
        VALUES ('project', '2026-10-16', 100, 100, 0, 0);
    `);

    const result = await DailyPulseService.compute("project", { now });

    expect(result.ga4.evaluated).toBe(false);
    expect(!result.ga4.evaluated && result.ga4.reason).toContain(
      "starts on 2026-10-16; the comparison needs a full baseline from 2026-10-15",
    );
  });
});
