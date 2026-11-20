import { beforeAll, describe, expect, it, vi } from "vitest";
import { getArchivedSearchPerformanceTool } from "@/server/mcp/tools/search-archive-tools";
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import { SearchArchiveService } from "./SearchArchiveService";

// Reads of the archive: its status and the archived rows.

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: async (
      _organizationId: string,
      projectId: string,
    ) => (projectId === "project" ? { id: projectId } : null),
  },
}));

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

describe("archive reads", () => {
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
      {
        page: "https://a.com/",
        clicks: 4,
        impressions: 400,
        ctr: 0.01,
        position: 7,
      },
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

  it("pages site datasets too", async () => {
    await testDb.client.executeMultiple(`
      INSERT INTO ga4_daily_site (project_id, date, sessions, organic_sessions, key_events, organic_key_events)
        VALUES ('project', '2024-01-01', 1, 1, 0, 0), ('project', '2024-01-02', 1, 1, 0, 0),
               ('project', '2024-01-03', 1, 1, 0, 0);
    `);
    const context = makeToolContext({ organizationId: "organization" });
    const first = await getArchivedSearchPerformanceTool.handler(
      {
        projectId: "project",
        dataset: "ga4_site",
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        limit: 2,
      },
      context,
    );
    expect(first.structuredContent).toMatchObject({
      rowCount: 2,
      hasMore: true,
      nextOffset: 2,
    });
    const last = await getArchivedSearchPerformanceTool.handler(
      {
        projectId: "project",
        dataset: "ga4_site",
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        limit: 2,
        offset: 2,
      },
      context,
    );
    expect(last.structuredContent).toMatchObject({
      rowCount: 1,
      hasMore: false,
      nextOffset: null,
    });
  });
});
