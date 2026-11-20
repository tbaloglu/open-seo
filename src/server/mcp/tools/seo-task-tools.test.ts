import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  listSeoTasksTool,
  saveSeoTasksTool,
  updateSeoTaskStatusTool,
} from "./seo-task-tools";
import { makeToolContext } from "./tool-test-support";

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

// Projects "project" and "other" belong to different organizations; the
// caller's credential is bound to "organization".
const context = makeToolContext({ organizationId: "organization" });

beforeAll(async () => {
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO organization (id, name, slug, created_at)
      VALUES ('other-org', 'Other', 'other-org', 0);
    INSERT INTO projects (id, organization_id, name) VALUES ('other', 'other-org', 'Other');
    INSERT INTO reports (id, project_id, title, summary, html, created_by, created_by_user_id, size_bytes)
      VALUES ('report', 'project', 'March', 's', '<p></p>', 'Claude', 'user', 7),
             ('other-report', 'other', 'Other', 's', '<p></p>', 'Claude', 'user', 7);
  `);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await testDb.client.execute("DELETE FROM seo_tasks");
  getProjectForOrganization.mockImplementation(
    async (organizationId: string, projectId: string) =>
      (organizationId === "organization" && projectId === "project") ||
      (organizationId === "other-org" && projectId === "other")
        ? { id: projectId, organizationId }
        : null,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

type SaveTasks = Parameters<typeof saveSeoTasksTool.handler>[0]["tasks"];

const save = (projectId: string, tasks: SaveTasks, ctx = context) =>
  saveSeoTasksTool.handler({ projectId, tasks }, ctx);

const tasksOf = async (projectId: string) =>
  (await listSeoTasksTool.handler({ projectId }, context)).structuredContent
    .tasks;

describe("SEO task tools", () => {
  it("updates a task by code on a second import instead of duplicating it", async () => {
    await save("project", [
      {
        code: "A1",
        title: "Fix titles",
        affectedUrls: ["https://a.com/x", "https://a.com/x", "https://a.com/y"],
        sourceReportId: "report",
      },
    ]);
    const second = await save("project", [
      {
        code: "A1",
        title: "Fix title tags",
        affectedUrls: ["https://a.com/z"],
      },
    ]);

    expect(second.structuredContent).toMatchObject({ created: 0, updated: 1 });
    const tasks = await tasksOf("project");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      code: "A1",
      title: "Fix title tags",
      status: "proposed",
      sourceReportId: "report",
      affectedUrls: ["https://a.com/z"],
    });
  });

  it("stamps done_at when a task becomes done and clears it when it leaves done", async () => {
    vi.setSystemTime("2026-11-01T10:00:00.000Z");
    await save("project", [{ code: "B1", title: "Add FAQ" }]);
    const [created] = await tasksOf("project");
    vi.setSystemTime("2026-11-20T10:00:00.000Z");

    const done = await updateSeoTaskStatusTool.handler(
      {
        projectId: "project",
        code: "B1",
        status: "done",
        outcomeNote: "Clicks +40%",
      },
      context,
    );
    expect(done.structuredContent.task).toMatchObject({
      doneAt: "2026-11-20T10:00:00.000Z",
      statusChangedAt: "2026-11-20T10:00:00.000Z",
    });
    expect(created.statusChangedAt).toBe("2026-11-01T10:00:00.000Z");

    const reopened = await updateSeoTaskStatusTool.handler(
      { projectId: "project", taskId: created.id, status: "in_progress" },
      context,
    );
    expect(reopened.structuredContent.task).toMatchObject({
      status: "in_progress",
      doneAt: null,
      outcomeNote: "Clicks +40%",
    });
  });

  it("replaces only a task's URLs when nothing else is given", async () => {
    await save("project", [
      { code: "D1", title: "Links", affectedUrls: ["https://a.com/old"] },
    ]);
    const [task] = await tasksOf("project");
    const result = await save("project", [
      { id: task.id, affectedUrls: ["https://a.com/new"] },
    ]);
    expect(result.structuredContent.results[0]).toMatchObject({
      action: "updated",
      task: { title: "Links", affectedUrls: ["https://a.com/new"] },
    });
  });

  it("keeps the status stamp when the status does not change", async () => {
    vi.setSystemTime("2026-11-01T10:00:00.000Z");
    await save("project", [{ code: "C1", title: "Speed", status: "selected" }]);
    vi.setSystemTime("2026-11-20T10:00:00.000Z");
    await save("project", [{ code: "C1", status: "selected" }]);
    const [after] = await tasksOf("project");
    expect(after.statusChangedAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("refuses a project outside the caller's organization", async () => {
    await expect(
      listSeoTasksTool.handler({ projectId: "other" }, context),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("never reaches another project's task or report by id", async () => {
    const otherContext = makeToolContext({ organizationId: "other-org" });
    await save("other", [{ code: "X1", title: "Theirs" }], otherContext);
    const [theirs] = (
      await listSeoTasksTool.handler({ projectId: "other" }, otherContext)
    ).structuredContent.tasks;

    const result = await save("project", [{ id: theirs.id, title: "Mine" }]);
    expect(result.structuredContent.results[0]).toMatchObject({
      action: "error",
    });
    await expect(
      updateSeoTaskStatusTool.handler(
        { projectId: "project", taskId: theirs.id, status: "done" },
        context,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      save("project", [
        { code: "A9", title: "Linked", sourceReportId: "other-report" },
      ]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await tasksOf("project")).toEqual([]);
  });
});
