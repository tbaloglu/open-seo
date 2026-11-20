import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AppError } from "@/server/lib/errors";
import { runScheduledSearchArchive } from "./scheduledSearchArchive";
import { SearchArchiveService } from "./SearchArchiveService";

const { testDb, createWorkflow, workflowStatus } = await vi.hoisted(
  async () => {
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
      workflowStatus: vi.fn<(id: string) => Promise<{ status: string }>>(),
    };
  },
);

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    SEARCH_ARCHIVE_WORKFLOW: {
      create: createWorkflow,
      get: async (id: string) => ({
        status: () => workflowStatus(id),
        terminate: async () => {},
      }),
    },
  },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
// Accounts mode, where a connection counts only while its connector is a
// member of the organization.
vi.mock("@/server/lib/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usesBetterAuthServer: async () => true,
}));

// 06:00 in Istanbul (UTC+3).
const SIX_AM = new Date("2026-11-20T03:00:00Z");
const hoursAgo = (hours: number) =>
  new Date(SIX_AM.getTime() - hours * 60 * 60_000).toISOString();
const later = (minutes: number) =>
  vi.setSystemTime(new Date(SIX_AM.getTime() + minutes * 60_000));

const started = () =>
  createWorkflow.mock.calls.map(
    ([options]) => `${options.params.projectId}:${options.params.mode}`,
  );

async function project(
  id: string,
  connection: "gsc" | "ga4" | "none" = "gsc",
  connector = "user",
) {
  await testDb.client.execute({
    sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, 'organization', ?)",
    args: [id, id],
  });
  if (connection === "gsc") {
    await testDb.client.execute({
      sql: `INSERT INTO gsc_connections (id, project_id, organization_id, site_url, connected_by_user_id)
        VALUES (?, ?, 'organization', 'sc-domain:a.com', ?)`,
      args: [`gsc-${id}`, id, connector],
    });
  }
  if (connection === "ga4") {
    await testDb.client.execute({
      sql: `INSERT INTO ga4_connections (id, project_id, organization_id, property_id, property_display_name,
          property_time_zone, property_currency_code, connected_by_user_id, ga4_account_id)
        VALUES (?, ?, 'organization', 'properties/1', 'A', 'Europe/Istanbul', 'TRY', ?, 'acc')`,
      args: [`ga4-${id}`, id, connector],
    });
  }
}

async function run(
  projectId: string,
  mode: "backfill" | "incremental",
  status: "running" | "completed" | "failed",
  startedHoursAgo: number,
  finishedHoursAgo: number | null = null,
) {
  await testDb.client.execute({
    sql: `INSERT INTO search_archive_runs (project_id, run_id, mode, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      projectId,
      `run-${projectId}`,
      mode,
      status,
      hoursAgo(startedHoursAgo),
      finishedHoursAgo === null ? null : hoursAgo(finishedHoursAgo),
    ],
  });
}

const runOf = async (projectId: string) =>
  (
    await testDb.client.execute({
      sql: "SELECT mode, status FROM search_archive_runs WHERE project_id = ?",
      args: [projectId],
    })
  ).rows[0];

beforeAll(async () => {
  await testDb.seedProject();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SIX_AM);
  createWorkflow.mockResolvedValue(undefined);
  workflowStatus.mockResolvedValue({ status: "running" });
  await testDb.client.executeMultiple(`
    DELETE FROM search_archive_runs;
    DELETE FROM gsc_connections;
    DELETE FROM ga4_connections;
    DELETE FROM member;
    DELETE FROM projects WHERE id != 'project';
    INSERT OR IGNORE INTO user (id, name, email) VALUES ('user', 'User', 'user@example.com');
    INSERT INTO member (id, organization_id, user_id, created_at)
      VALUES ('m', 'organization', 'user', 0);
  `);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("daily search archive scheduler", () => {
  it("starts nothing before 06:00 Istanbul time", async () => {
    await project("never");
    vi.setSystemTime(new Date("2026-11-20T02:59:00Z"));
    await runScheduledSearchArchive();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("picks due projects: first runs as backfills, then the longest waiting", async () => {
    await project("never", "ga4");
    await project("stale");
    await project("fresh");
    await project("failed-recently");
    await project("unconnected", "none");
    await project("left", "gsc", "former-member");
    await run("stale", "incremental", "completed", 21.5, 21);
    await run("fresh", "incremental", "completed", 2.5, 2);
    await run("failed-recently", "incremental", "failed", 1.5, 1);

    await runScheduledSearchArchive();

    expect(started()).toEqual(["never:backfill", "stale:incremental"]);
  });

  it("keeps at most three runs going and two backfills among them", async () => {
    await project("a");
    await project("b");
    await project("c");
    await project("d");
    await project("e");
    await run("d", "incremental", "completed", 30, 30);
    await run("e", "incremental", "completed", 25, 25);

    await runScheduledSearchArchive();
    // a, b: backfills; c waits for a backfill slot; d fills the third slot.
    expect(started()).toEqual(["a:backfill", "b:backfill", "d:incremental"]);

    later(5);
    await runScheduledSearchArchive();
    expect(createWorkflow).toHaveBeenCalledTimes(3);

    // One backfill finishes: its slot goes to the waiting backfill.
    await testDb.client.execute(
      "UPDATE search_archive_runs SET status = 'completed', finished_at = started_at WHERE project_id = 'a'",
    );
    later(10);
    await runScheduledSearchArchive();
    expect(started().slice(3)).toEqual(["c:backfill"]);
  });

  it("settles a dead run without letting a healthy long run block or be restarted", async () => {
    await project("dead");
    await project("slow");
    await run("dead", "incremental", "running", 13);
    await run("slow", "backfill", "running", 13);
    workflowStatus.mockImplementation(async (id) => ({
      status: id === "run-dead" ? "errored" : "waiting",
    }));

    await runScheduledSearchArchive();

    expect(await runOf("dead")).toMatchObject({ status: "failed" });
    expect(await runOf("slow")).toMatchObject({ status: "running" });
    // The dead run just failed, so it waits out the back-off.
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("backs off a project that cannot start without stopping the others", async () => {
    await project("broken");
    await project("ok");
    const realStart = SearchArchiveService.start;
    vi.spyOn(SearchArchiveService, "start").mockImplementation(
      async (projectId, mode) => {
        if (projectId === "broken") {
          throw new AppError("VALIDATION_ERROR", "Nothing connected.");
        }
        return realStart(projectId, mode);
      },
    );

    await runScheduledSearchArchive();
    expect(started()).toEqual(["ok:backfill"]);
    expect(await runOf("broken")).toMatchObject({ status: "failed" });

    later(5);
    await runScheduledSearchArchive();
    expect(SearchArchiveService.start).toHaveBeenCalledTimes(2);
  });
});
