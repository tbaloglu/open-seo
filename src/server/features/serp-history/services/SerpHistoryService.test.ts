import { beforeAll, describe, expect, it, vi } from "vitest";
import { SerpHistoryService } from "./SerpHistoryService";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));

type Feature = [type: string, value: string, domain: string | null];

/** A completed check of a tracker. */
function run(id: string, config: string, day: number) {
  return `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at)
    VALUES ('${id}', '${config}', 'project', 'completed', '2026-11-0${day}T03:00:00.000Z');`;
}

/** A keyword's rank in a check and, unless `page` is null, its saved page. */
function check(
  runId: string,
  keyword: string,
  position: number | null,
  page: { top10: string[]; features?: Feature[] } | null,
) {
  const rows = [
    `INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position)
      VALUES ('${runId}', '${keyword}', '${keyword}', 'mobile', ${position ?? "NULL"});`,
  ];
  page?.top10.forEach((domain, index) =>
    rows.push(`INSERT INTO serp_snapshot_results (run_id, tracking_keyword_id, device, rank, domain)
      VALUES ('${runId}', '${keyword}', 'mobile', ${index + 1}, '${domain}');`),
  );
  page?.features?.forEach(([type, value, domain], index) =>
    rows.push(`INSERT INTO serp_snapshot_features (run_id, tracking_keyword_id, device, feature_type, sort_order, value, domain)
      VALUES ('${runId}', '${keyword}', 'mobile', '${type}', ${index}, '${value}', ${domain ? `'${domain}'` : "NULL"});`),
  );
  return rows.join("\n");
}

beforeAll(async () => {
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO projects (id, organization_id, name) VALUES ('other', 'organization', 'Other');
    INSERT INTO rank_tracking_configs (id, project_id, domain, devices, serp_depth, language_code)
      VALUES ('config', 'project', 'openseo.so', 'mobile', 10, 'tr'),
             ('two', 'project', 'two.example', 'mobile', 10, 'tr'),
             ('one', 'project', 'one.example', 'mobile', 10, 'tr'),
             ('elsewhere', 'other', 'openseo.so', 'mobile', 10, 'tr');
    INSERT INTO rank_tracking_keywords (id, config_id, keyword)
      VALUES ('kw', 'config', 'turşu kavanozu'), ('kw-new', 'config', 'turşu suyu'),
             ('kw-other', 'elsewhere', 'turşu kavanozu');
    ${run("first", "config", 1)}
    ${run("second", "config", 2)}
    ${run("latest", "config", 3)}
    ${run("two-a", "two", 1)}
    ${run("two-b", "two", 2)}
    ${run("one-a", "one", 1)}
    ${run("elsewhere-a", "elsewhere", 1)}
    ${check("first", "kw", 5, { top10: ["a.com", "b.com"], features: [["people_also_ask", "q1", null]] })}
    ${check("second", "kw", 3, {
      top10: ["a.com", "c.com"],
      features: [
        ["people_also_ask", "q1", null],
        ["people_also_ask", "q2", null],
        ["ai_overview", "rival.com: Guide", "rival.com"],
      ],
    })}
    ${check("latest", "kw", 3, {
      top10: ["c.com", "d.com"],
      features: [
        ["people_also_ask", "q2", null],
        ["people_also_ask", "q3", null],
        ["ai_overview", "openseo.so: Guide", "openseo.so"],
        ["video", "youtube.com: Kavanoz", "youtube.com"],
      ],
    })}
    ${check("first", "kw-new", null, null)}
    ${check("second", "kw-new", null, { top10: ["e.com"] })}
    ${check("latest", "kw-new", null, { top10: ["e.com"] })}
    ${check("two-a", "kw", 4, { top10: ["a.com"] })}
    ${check("two-b", "kw", 2, { top10: ["b.com"] })}
  `);
});

const changes = (input: {
  trackerId: string;
  fromRunId?: string;
  toRunId?: string;
}) =>
  SerpHistoryService.getChanges({
    projectId: "project",
    projectDefaultDevice: "desktop",
    ...input,
  });

const history = (input: {
  keyword: string;
  trackerId?: string;
  device?: "desktop";
}) =>
  SerpHistoryService.getKeywordHistory({
    projectId: "project",
    projectDefaultDevice: "mobile",
    runs: 6,
    ...input,
  });

describe("SERP changes", () => {
  it("compares the latest two checks and marks changes that held since the check before", async () => {
    const result = await changes({ trackerId: "config" });

    expect([
      result.runs.previous?.id,
      result.runs.from.id,
      result.runs.to.id,
    ]).toEqual(["first", "second", "latest"]);
    expect(
      result.keywords.find((row) => row.trackingKeywordId === "kw"),
    ).toEqual({
      trackingKeywordId: "kw",
      keyword: "kw",
      changed: true,
      position: { previous: 5, from: 3, to: 3, change: 0, status: "held" },
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
      aiOverview: {
        previous: "absent",
        from: "not_cited",
        to: "cited",
        status: "changed",
      },
      featureTypes: {
        added: [
          { value: "video", persisted: false },
          { value: "ai_overview", persisted: true },
        ],
        removed: [],
      },
    });
    // kw-new has no page from the first check: compared without it, and
    // left out of the "previous" counts.
    expect(
      result.keywords.find((row) => row.trackingKeywordId === "kw-new"),
    ).toMatchObject({
      changed: false,
      position: { previous: null, status: "unchanged" },
    });
    expect(result.domains).toEqual([
      {
        domain: "c.com",
        previous: 0,
        from: 1,
        to: 1,
        delta: 0,
        deltaSincePrevious: 1,
      },
      {
        domain: "d.com",
        previous: 0,
        from: 0,
        to: 1,
        delta: 1,
        deltaSincePrevious: 1,
      },
      {
        domain: "a.com",
        previous: 1,
        from: 1,
        to: 0,
        delta: -1,
        deltaSincePrevious: -1,
      },
      {
        domain: "b.com",
        previous: 1,
        from: 0,
        to: 0,
        delta: 0,
        deltaSincePrevious: -1,
      },
    ]);
  });

  it("with exactly two checks, reports every change as single-check", async () => {
    const result = await changes({ trackerId: "two" });

    expect(result.runs.previous).toBeNull();
    expect(result.keywords[0]).toMatchObject({
      position: {
        previous: null,
        from: 4,
        to: 2,
        change: 2,
        status: "changed",
      },
      top10: {
        entered: [{ value: "b.com", persisted: false }],
        left: [{ value: "a.com", persisted: false }],
      },
    });
    expect(result.domains.map((row) => row.deltaSincePrevious)).toEqual([
      null,
      null,
    ]);
  });

  it.each([
    ["fewer than two checks", { trackerId: "one" }, "VALIDATION_ERROR"],
    [
      "a run of another tracker",
      { trackerId: "config", toRunId: "two-b" },
      "NOT_FOUND",
    ],
    [
      "from not earlier than to",
      { trackerId: "config", fromRunId: "latest", toRunId: "second" },
      "VALIDATION_ERROR",
    ],
    ["another project's tracker", { trackerId: "elsewhere" }, "NOT_FOUND"],
  ])("rejects %s", async (_case, input, code) => {
    await expect(changes(input)).rejects.toMatchObject({ code });
  });
});

describe("SERP history", () => {
  it("finds the keyword in the tracker's language", async () => {
    const result = await history({ keyword: "TURŞU KAVANOZU" });

    expect(result.keyword.id).toBe("kw");
  });

  it("lists a check whose page wasn't saved as not saved", async () => {
    const result = await history({ keyword: "turşu suyu" });

    expect(result.checks.map((row) => [row.runId, row.saved])).toEqual([
      ["latest", true],
      ["second", true],
      ["first", false],
    ]);
  });

  it.each([
    [
      "another project's tracker",
      { keyword: "turşu kavanozu", trackerId: "elsewhere" },
      "NOT_FOUND",
    ],
    [
      "a device the tracker doesn't check",
      { keyword: "turşu kavanozu", device: "desktop" as const },
      "VALIDATION_ERROR",
    ],
  ])("rejects %s", async (_case, input, code) => {
    await expect(history(input)).rejects.toMatchObject({ code });
  });
});
