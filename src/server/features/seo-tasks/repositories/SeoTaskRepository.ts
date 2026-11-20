import { and, asc, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { omit } from "remeda";
import { db } from "@/db";
import { seoTasks, seoTaskUrls } from "@/db/schema";
import { runBatch } from "@/db/runBatch";
import type {
  SeoTask,
  SeoTaskPriority,
  SeoTaskSize,
  SeoTaskStatus,
} from "@/shared/seo-tasks";

// Every query filters on `project_id`: callers authorize the project they were
// given, not the task, so a guessed id from another project never resolves.

type TaskRow = typeof seoTasks.$inferSelect;
export type SeoTaskFields = Omit<
  TaskRow,
  "id" | "projectId" | "createdAt" | "statusChangedAt" | "doneAt"
> & {
  statusChangedAt: string;
  doneAt: string | null;
};

// D1 binds at most 100 parameters per statement.
const IDS_PER_QUERY = 90;
// seo_task_urls has 3 columns.
const URL_ROWS_PER_INSERT = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const priorityOrder = sql`CASE ${seoTasks.priority} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

async function urlsFor(taskIds: string[]): Promise<Map<string, string[]>> {
  const byTask = new Map<string, string[]>();
  for (const ids of chunk(taskIds, IDS_PER_QUERY)) {
    const rows = await db
      .select()
      .from(seoTaskUrls)
      .where(inArray(seoTaskUrls.taskId, ids))
      .orderBy(asc(seoTaskUrls.taskId), asc(seoTaskUrls.sortOrder));
    for (const row of rows) {
      const urls = byTask.get(row.taskId) ?? [];
      urls.push(row.url);
      byTask.set(row.taskId, urls);
    }
  }
  return byTask;
}

async function withUrls(rows: TaskRow[]): Promise<SeoTask[]> {
  const urls = await urlsFor(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...omit(row, ["projectId"]),
    affectedUrls: urls.get(row.id) ?? [],
  }));
}

function listFilter(params: {
  projectId: string;
  statuses?: SeoTaskStatus[];
  priorities?: SeoTaskPriority[];
  sizes?: SeoTaskSize[];
}): SQL | undefined {
  return and(
    eq(seoTasks.projectId, params.projectId),
    params.statuses?.length
      ? inArray(seoTasks.status, params.statuses)
      : undefined,
    params.priorities?.length
      ? inArray(seoTasks.priority, params.priorities)
      : undefined,
    params.sizes?.length ? inArray(seoTasks.size, params.sizes) : undefined,
  );
}

async function list(params: {
  projectId: string;
  statuses?: SeoTaskStatus[];
  priorities?: SeoTaskPriority[];
  sizes?: SeoTaskSize[];
  limit: number;
  offset: number;
}) {
  const where = listFilter(params);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(seoTasks)
      .where(where)
      .orderBy(
        priorityOrder,
        asc(seoTasks.code),
        asc(seoTasks.createdAt),
        asc(seoTasks.id),
      )
      .limit(params.limit)
      .offset(params.offset),
    db.select({ total: count() }).from(seoTasks).where(where),
  ]);
  return { tasks: await withUrls(rows), total };
}

/** How many of the project's tasks are in each status. */
async function countByStatus(
  projectId: string,
): Promise<Partial<Record<SeoTaskStatus, number>>> {
  const rows = await db
    .select({ status: seoTasks.status, total: count() })
    .from(seoTasks)
    .where(eq(seoTasks.projectId, projectId))
    .groupBy(seoTasks.status);
  return Object.fromEntries(rows.map((row) => [row.status, row.total]));
}

async function findByIds(projectId: string, ids: string[]) {
  const rows: TaskRow[] = [];
  for (const part of chunk(ids, IDS_PER_QUERY)) {
    rows.push(
      ...(await db
        .select()
        .from(seoTasks)
        .where(
          and(eq(seoTasks.projectId, projectId), inArray(seoTasks.id, part)),
        )),
    );
  }
  return rows;
}

async function findByCodes(projectId: string, codes: string[]) {
  const rows: TaskRow[] = [];
  for (const part of chunk(codes, IDS_PER_QUERY)) {
    rows.push(
      ...(await db
        .select()
        .from(seoTasks)
        .where(
          and(eq(seoTasks.projectId, projectId), inArray(seoTasks.code, part)),
        )),
    );
  }
  return rows;
}

async function countForProject(projectId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(seoTasks)
    .where(eq(seoTasks.projectId, projectId));
  return total;
}

type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

function urlInserts(tx: BatchExecutor, taskId: string, urls: string[]) {
  return chunk(
    urls.map((url, sortOrder) => ({ taskId, url, sortOrder })),
    URL_ROWS_PER_INSERT,
  ).map((rows) => tx.insert(seoTaskUrls).values(rows));
}

/** Inserts a task and its URLs together. */
async function insert(task: {
  id: string;
  projectId: string;
  createdAt: string;
  fields: SeoTaskFields;
  urls: string[];
}) {
  await runBatch((tx) => [
    tx.insert(seoTasks).values({
      id: task.id,
      projectId: task.projectId,
      createdAt: task.createdAt,
      ...task.fields,
    }),
    ...urlInserts(tx, task.id, task.urls),
  ]);
}

/** Updates a task; `urls`, when given, replaces its URL list in the same batch. */
async function update(task: {
  id: string;
  projectId: string;
  fields: Partial<SeoTaskFields>;
  urls?: string[];
}) {
  // An update that only replaces URLs has no fields: Drizzle refuses an
  // empty SET, so the statement is left out.
  const hasFields = Object.keys(task.fields).length > 0;
  await runBatch((tx) => [
    ...(hasFields
      ? [
          tx
            .update(seoTasks)
            .set(task.fields)
            .where(
              and(
                eq(seoTasks.id, task.id),
                eq(seoTasks.projectId, task.projectId),
              ),
            ),
        ]
      : []),
    ...(task.urls
      ? [
          tx.delete(seoTaskUrls).where(eq(seoTaskUrls.taskId, task.id)),
          ...urlInserts(tx, task.id, task.urls),
        ]
      : []),
  ]);
}

async function getTask(projectId: string, id: string): Promise<SeoTask | null> {
  const [row] = await findByIds(projectId, [id]);
  if (!row) return null;
  const [task] = await withUrls([row]);
  return task;
}

export const SeoTaskRepository = {
  list,
  countByStatus,
  findByIds,
  findByCodes,
  countForProject,
  insert,
  update,
  getTask,
};
