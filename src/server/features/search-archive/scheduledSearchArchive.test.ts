import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runScheduledSearchArchive } from "./scheduledSearchArchive";

const { testDb, createWorkflow } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    createWorkflow:
      vi.fn<
        (options: {
          params: { projectId: string; mode: string };
        }) => Promise<void>
      >(),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    SEARCH_ARCHIVE_WORKFLOW: {
      create: createWorkflow,
      get: async () => ({ status: async () => ({ status: "running" }) }),
    },
  },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));

// 06:00 in Istanbul (UTC+3).
const SIX_AM = new Date("2026-11-20T03:00:00Z");
const hoursAgo = (hours: number) =>
  new Date(SIX_AM.getTime() - hours * 60 * 60_000).toISOString();

const startedProjects = () =>
  createWorkflow.mock.calls.map(
    ([options]) => `${options.params.projectId}:${options.params.mode}`,
  );

beforeAll(async () => {
  await testDb.seedProject();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SIX_AM);
  createWorkflow.mockResolvedValue(undefined);
  await testDb.client.executeMultiple(`
    DELETE FROM search_archive_runs;
    DELETE FROM gsc_connections;
    DELETE FROM ga4_connections;
    DELETE FROM projects WHERE id != 'project';
    INSERT INTO projects (id, organization_id, name, archived_at) VALUES
      ('never', 'organization', 'Never archived', NULL),
      ('stale', 'organization', 'Completed 21 hours ago', NULL),
      ('fresh', 'organization', 'Completed 2 hours ago', NULL),
      ('failed-recently', 'organization', 'Failed 1 hour ago', NULL),
      ('failed-long-ago', 'organization', 'Failed 7 hours ago', NULL),
      ('running', 'organization', 'Running', NULL),
      ('ga4-only', 'organization', 'Analytics only', NULL),
      ('unconnected', 'organization', 'Nothing connected', NULL),
      ('deleted', 'organization', 'Archived project', '2026-11-01T00:00:00.000Z');
  `);
  for (const id of [
    "never",
    "stale",
    "fresh",
    "failed-recently",
    "failed-long-ago",
    "running",
    "deleted",
  ]) {
    await testDb.client.execute({
      sql: `INSERT INTO gsc_connections (id, project_id, organization_id, site_url, connected_by_user_id)
        VALUES (?, ?, 'organization', 'sc-domain:a.com', 'user')`,
      args: [`gsc-${id}`, id],
    });
  }
  await testDb.client.execute(`INSERT INTO ga4_connections
    (id, project_id, organization_id, property_id, property_display_name, property_time_zone,
     property_currency_code, connected_by_user_id, ga4_account_id)
    VALUES ('ga4', 'ga4-only', 'organization', 'properties/1', 'A', 'Europe/Istanbul', 'TRY', 'user', 'acc')`);
  const run = (
    projectId: string,
    status: string,
    started: number,
    finished: number | null,
  ) =>
    testDb.client.execute({
      sql: `INSERT INTO search_archive_runs (project_id, run_id, mode, status, started_at, finished_at)
        VALUES (?, ?, 'incremental', ?, ?, ?)`,
      args: [
        projectId,
        `run-${projectId}`,
        status,
        hoursAgo(started),
        finished === null ? null : hoursAgo(finished),
      ],
    });
  await run("stale", "completed", 21.5, 21);
  await run("fresh", "completed", 2.5, 2);
  await run("failed-recently", "failed", 1.5, 1);
  await run("failed-long-ago", "failed", 7.5, 7);
  await run("running", "running", 0.5, null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("daily search archive scheduler", () => {
  it("starts nothing before 06:00 Istanbul time", async () => {
    vi.setSystemTime(new Date("2026-11-20T02:59:00Z"));
    await runScheduledSearchArchive();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("starts due projects three per tick, never-archived first, until all are done", async () => {
    await runScheduledSearchArchive();
    expect(startedProjects()).toEqual([
      "ga4-only:incremental",
      "never:incremental",
      "stale:incremental",
    ]);

    vi.setSystemTime(new Date(SIX_AM.getTime() + 5 * 60_000));
    await runScheduledSearchArchive();
    expect(startedProjects().slice(3)).toEqual(["failed-long-ago:incremental"]);

    // Everything due has a fresh run now.
    await runScheduledSearchArchive();
    expect(createWorkflow).toHaveBeenCalledTimes(4);
  });
});
