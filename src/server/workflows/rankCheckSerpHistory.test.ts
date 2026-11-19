import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import type { RankCheckTaskInput } from "@/server/lib/dataforseo";
import { runQueuedCheck } from "./rankCheckPaths";
import { retryRankChecks } from "./rankCheckRetries";

const { testDb, fetchRankCheckTaskResult } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    fetchRankCheckTaskResult: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  DB_BATCH_SIZE: 100,
  runBatch: testDb.runBatch,
  executeInBatches: <T>(
    items: T[],
    build: (tx: typeof testDb.db, item: T) => Promise<unknown>,
  ) => testDb.runBatch(() => items.map((item) => build(testDb.db, item))),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST: 100,
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only sleep is reached; pgStep is mocked
const step = { sleep: vi.fn() } as unknown as WorkflowStep;

const ctx = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the check paths only call this serp method
  client: {
    serp: {
      rankCheckTaskPost: async ({ tasks }: { tasks: RankCheckTaskInput[] }) =>
        tasks.map((task) => ({ ...task, taskId: `task_${task.keywordId}` })),
    },
  } as never,
  keywords: [{ id: "kw", keyword: "turşu kavanozu" }],
  devices: "mobile" as const,
  serpDepth: 10,
  domain: "openseo.so",
  locationCode: 2792,
  languageCode: "tr",
  runId: "run",
};

const organic = (rank: number, domain: string) => ({
  type: "organic",
  rank_group: rank,
  domain,
  url: `https://${domain}/`,
  title: domain,
});

/** The next task_get answers with this page and the site's position on it. */
function nextRead(position: number | null, items: object[] | null) {
  fetchRankCheckTaskResult.mockImplementationOnce(
    async (task: { keywordId: string; keyword: string }) => ({
      status: "completed",
      result: { ...task, position, url: null, serpFeatures: [] },
      items,
    }),
  );
}

async function savedPage() {
  const rows = await testDb.client.execute(
    "SELECT domain FROM serp_snapshot_results WHERE run_id = 'run' ORDER BY rank",
  );
  const features = await testDb.client.execute(
    "SELECT feature_type, value, domain FROM serp_snapshot_features WHERE run_id = 'run' ORDER BY feature_type, sort_order",
  );
  return {
    top10: rows.rows.map((row) => row.domain),
    features: features.rows.map((row) => [
      row.feature_type,
      row.value,
      row.domain,
    ]),
  };
}

beforeEach(async () => {
  await testDb.seedProject();
  // The keyword ranked in an earlier check, so a miss in this one is suspect
  // and read again.
  await testDb.client.executeMultiple(`
    DELETE FROM serp_snapshot_results;
    DELETE FROM serp_snapshot_features;
    DELETE FROM rank_snapshots;
    DELETE FROM rank_check_runs;
    DELETE FROM rank_tracking_configs;
    INSERT INTO rank_tracking_configs (id, project_id, domain, serp_depth)
      VALUES ('config', 'project', 'openseo.so', 10);
    INSERT INTO rank_check_runs (id, config_id, project_id, status)
      VALUES ('earlier', 'config', 'project', 'completed'),
             ('run', 'config', 'project', 'running');
    INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position)
      VALUES ('earlier', 'kw', 'turşu kavanozu', 'mobile', 2);
  `);
});

describe("SERP history of a rank check", () => {
  it("keeps the page of the read the rank snapshot keeps", async () => {
    // The first read is a page without the site, as a fake page would be.
    nextRead(null, [
      organic(1, "www.poisoned.example"),
      {
        type: "people_also_ask",
        items: [{ title: "Turşu kavanozu nasıl kapatılır?" }],
      },
    ]);
    await runQueuedCheck(step, ctx, Infinity);
    expect((await savedPage()).top10).toEqual(["poisoned.example"]);

    nextRead(2, [
      organic(1, "rival.com"),
      organic(2, "openseo.so"),
      {
        type: "ai_overview",
        references: [
          { domain: "openseo.so", title: "Kavanoz rehberi" },
          { domain: "google.com", url: "https://www.google.com/x" },
        ],
        // Sources on a nested element count too; a bare URL names its site.
        items: [
          {
            type: "ai_overview_element",
            references: [
              { url: "https://www.nested.example/a", title: "Nested" },
              { url: "https://maps.google.com/x", title: "Map" },
            ],
          },
        ],
      },
      { type: "local_pack", title: "Kavanozcu", domain: "kavanozcu.com" },
    ]);
    await retryRankChecks(step, ctx, "config", Infinity);

    expect(await savedPage()).toEqual({
      top10: ["rival.com", "openseo.so"],
      features: [
        ["ai_overview", "openseo.so: Kavanoz rehberi", "openseo.so"],
        ["ai_overview", "nested.example: Nested", "nested.example"],
        ["ai_overview", "Map", null],
        ["local_pack", "Kavanozcu", "kavanozcu.com"],
      ],
    });
  });

  it("drops the page of a miss the check discards as unconfirmed", async () => {
    nextRead(null, [organic(1, "poisoned.example")]);
    nextRead(null, [organic(1, "poisoned.example")]);

    await runQueuedCheck(step, ctx, Infinity);
    await retryRankChecks(step, ctx, "config", Infinity);

    expect(await savedPage()).toEqual({ top10: [], features: [] });
  });

  // Last: the second case drops a table this file's database doesn't get back.
  it.each([
    ["a page it can't read", async () => nextRead(5, null)],
    [
      "a database error",
      async () => {
        await testDb.client.execute("DROP TABLE serp_snapshot_features");
        nextRead(5, [organic(1, "rival.com"), organic(5, "openseo.so")]);
      },
    ],
  ])("still saves the ranks after %s", async (_case, arrange) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await arrange();

    await runQueuedCheck(step, ctx, Infinity);

    const ranks = await testDb.client.execute(
      "SELECT position FROM rank_snapshots WHERE run_id = 'run'",
    );
    expect(ranks.rows.map((row) => row.position)).toEqual([5]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("SERP history"),
      expect.anything(),
    );
  });
});
