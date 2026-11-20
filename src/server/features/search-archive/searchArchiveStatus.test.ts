import { beforeAll, describe, expect, it, vi } from "vitest";
import { SearchArchiveService } from "./SearchArchiveService";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));

beforeAll(async () => {
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO projects (id, organization_id, name) VALUES ('other', 'organization', 'Other');
  `);
});

describe("search archive status", () => {
  it("reports the dates that hold rows, not the months scanned", async () => {
    await testDb.client.executeMultiple(`
      INSERT INTO search_archive_periods (project_id, source, month, fetched_through, complete, row_count, fetched_at)
        VALUES ('project', 'gsc_page', '2025-07', '2025-07-31', 1, 0, '2025-08-10T00:00:00.000Z'),
               ('project', 'gsc_page', '2026-03', '2026-03-31', 1, 2, '2026-04-10T00:00:00.000Z'),
               ('project', 'ga4_site', '2025-07', '2025-07-31', 1, 0, '2025-08-10T00:00:00.000Z');
      INSERT INTO gsc_daily_page (project_id, date, page, clicks, impressions, ctr, position)
        VALUES ('project', '2026-03-04', 'https://a.com/', 1, 10, 0.1, 3),
               ('project', '2026-03-20', 'https://a.com/', 1, 10, 0.1, 3),
               ('other', '2025-07-02', 'https://b.com/', 1, 10, 0.1, 3);
    `);

    const { coverage } = await SearchArchiveService.getStatus("project");

    expect(coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "gsc_page",
          firstMonth: "2025-07",
          firstDataDate: "2026-03-04",
          lastDataDate: "2026-03-20",
        }),
        expect.objectContaining({
          source: "ga4_site",
          firstDataDate: null,
          lastDataDate: null,
        }),
      ]),
    );
  });
});
