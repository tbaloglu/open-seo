import { beforeAll, describe, expect, it, vi } from "vitest";
import { SerpHistoryService } from "./SerpHistoryService";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));

/** One check's page for keyword "kw": top 10 domains and features. */
function check(
  run: string,
  day: number,
  position: number,
  top10: string[],
  features: Array<[type: string, value: string, domain: string | null]>,
) {
  return `
    INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at)
      VALUES ('${run}', 'config', 'project', 'completed', '2026-11-0${day}T03:00:00.000Z');
    INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position)
      VALUES ('${run}', 'kw', 'turşu kavanozu', 'mobile', ${position});
    ${top10
      .map(
        (domain, index) => `
    INSERT INTO serp_snapshot_results (run_id, tracking_keyword_id, device, rank, domain)
      VALUES ('${run}', 'kw', 'mobile', ${index + 1}, '${domain}');`,
      )
      .join("")}
    ${features
      .map(
        ([type, value, domain], index) => `
    INSERT INTO serp_snapshot_features (run_id, tracking_keyword_id, device, feature_type, sort_order, value, domain)
      VALUES ('${run}', 'kw', 'mobile', '${type}', ${index}, '${value}', ${domain ? `'${domain}'` : "NULL"});`,
      )
      .join("")}`;
}

beforeAll(async () => {
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO rank_tracking_configs (id, project_id, domain, devices, serp_depth)
      VALUES ('config', 'project', 'openseo.so', 'mobile', 10);
    ${check("first", 1, 5, ["a.com", "b.com"], [["people_also_ask", "q1", null]])}
    ${check(
      "second",
      2,
      3,
      ["a.com", "c.com"],
      [
        ["people_also_ask", "q1", null],
        ["people_also_ask", "q2", null],
        ["ai_overview", "rival.com: Guide", "rival.com"],
      ],
    )}
    ${check(
      "latest",
      3,
      3,
      ["c.com", "d.com"],
      [
        ["people_also_ask", "q2", null],
        ["people_also_ask", "q3", null],
        ["ai_overview", "openseo.so: Guide", "openseo.so"],
        ["video", "youtube.com: Kavanoz", "youtube.com"],
      ],
    )}
  `);
});

describe("SERP changes", () => {
  it("compares the latest two checks and marks changes that held since the check before", async () => {
    const changes = await SerpHistoryService.getChanges({
      projectId: "project",
      projectDefaultDevice: "desktop",
      trackerId: "config",
    });

    expect(changes.runs.from.id).toBe("second");
    expect(changes.runs.to.id).toBe("latest");
    expect(changes.keywords).toEqual([
      {
        trackingKeywordId: "kw",
        keyword: "turşu kavanozu",
        changed: true,
        position: { previous: 5, from: 3, to: 3, change: 0 },
        top10: {
          entered: [
            { value: "d.com", persisted: false },
            { value: "c.com", persisted: true },
          ],
          left: [
            { value: "a.com", persisted: false },
            { value: "b.com", persisted: true },
          ],
        },
        questions: {
          added: [
            { value: "q3", persisted: false },
            { value: "q2", persisted: true },
          ],
          removed: [{ value: "q1", persisted: false }],
        },
        aiOverview: { previous: "absent", from: "not_cited", to: "cited" },
        featureTypes: {
          added: [
            { value: "video", persisted: false },
            { value: "ai_overview", persisted: true },
          ],
          removed: [],
        },
      },
    ]);
    expect(changes.domains).toEqual([
      { domain: "d.com", previous: 0, from: 0, to: 1, delta: 1 },
      { domain: "a.com", previous: 1, from: 1, to: 0, delta: -1 },
    ]);
  });
});
