import { isUniqueViolation } from "@/db/isUniqueViolation";
import { ReportRepository } from "@/server/features/reports/repositories/ReportRepository";
import {
  SeoTaskRepository,
  type SeoTaskFields,
} from "@/server/features/seo-tasks/repositories/SeoTaskRepository";
import { AppError } from "@/server/lib/errors";
import {
  SEO_TASK_MAX_PER_PROJECT,
  type SeoTask,
  type SeoTaskPriority,
  type SeoTaskSize,
  type SeoTaskStatus,
} from "@/shared/seo-tasks";

/** A task to create, or to update when `id` or `code` matches one. */
type SeoTaskInput = {
  id?: string;
  code?: string | null;
  title?: string;
  description?: string | null;
  evidence?: string | null;
  affectedUrls?: string[];
  expectedImpact?: string | null;
  size?: SeoTaskSize | null;
  priority?: SeoTaskPriority;
  status?: SeoTaskStatus;
  sourceReportId?: string | null;
  outcomeNote?: string | null;
};

/** A task is addressed by its id, or by its code within the project. */
type SeoTaskRef = { id: string } | { code: string };

type SaveOutcome =
  | { index: number; action: "created" | "updated"; task: SeoTask }
  | { index: number; action: "error"; message: string };

type TaskRow = Awaited<ReturnType<typeof SeoTaskRepository.findByIds>>[number];

/**
 * The fields a status change sets. Any status may follow any other: the owner
 * reopens and drops tasks freely. `done_at` is set when a task becomes done
 * and cleared when it leaves done; a save with the same status changes nothing.
 */
function statusFields(
  current: { status: SeoTaskStatus } | null,
  next: SeoTaskStatus,
  now: string,
): Partial<SeoTaskFields> {
  if (current?.status === next) return {};
  return {
    status: next,
    statusChangedAt: now,
    doneAt: next === "done" ? now : null,
  };
}

function dedupeUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
}

async function list(params: {
  projectId: string;
  statuses?: SeoTaskStatus[];
  priorities?: SeoTaskPriority[];
  sizes?: SeoTaskSize[];
  limit: number;
  offset: number;
}) {
  const [{ tasks, total }, countsByStatus] = await Promise.all([
    SeoTaskRepository.list(params),
    SeoTaskRepository.countByStatus(params.projectId),
  ]);
  const nextOffset = params.offset + tasks.length;
  return {
    tasks,
    total,
    countsByStatus,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

async function assertReportsInProject(projectId: string, reportIds: string[]) {
  for (const reportId of new Set(reportIds)) {
    const report = await ReportRepository.getReport(projectId, reportId);
    if (!report) {
      throw new AppError(
        "NOT_FOUND",
        `Report ${reportId} was not found in this project.`,
      );
    }
  }
}

/** The fields an update writes: only those the input names. */
function updateFields(
  input: SeoTaskInput,
  existing: TaskRow,
  now: string,
): Partial<SeoTaskFields> {
  const fields: Partial<SeoTaskFields> = {};
  if (input.code !== undefined) fields.code = input.code;
  if (input.title !== undefined) fields.title = input.title;
  if (input.description !== undefined) fields.description = input.description;
  if (input.evidence !== undefined) fields.evidence = input.evidence;
  if (input.expectedImpact !== undefined)
    fields.expectedImpact = input.expectedImpact;
  if (input.size !== undefined) fields.size = input.size;
  if (input.priority !== undefined) fields.priority = input.priority;
  if (input.sourceReportId !== undefined)
    fields.sourceReportId = input.sourceReportId;
  if (input.outcomeNote !== undefined) fields.outcomeNote = input.outcomeNote;
  return input.status
    ? { ...fields, ...statusFields(existing, input.status, now) }
    : fields;
}

async function writeTask(params: {
  projectId: string;
  input: SeoTaskInput;
  existing: TaskRow | undefined;
  now: string;
}): Promise<{ action: "created" | "updated"; id: string }> {
  const { projectId, input, existing, now } = params;
  const urls =
    input.affectedUrls === undefined
      ? undefined
      : dedupeUrls(input.affectedUrls);
  if (existing) {
    const fields = updateFields(input, existing, now);
    if (Object.keys(fields).length > 0 || urls) {
      await SeoTaskRepository.update({
        id: existing.id,
        projectId,
        fields,
        urls,
      });
    }
    return { action: "updated", id: existing.id };
  }
  const status = input.status ?? "proposed";
  const id = crypto.randomUUID();
  await SeoTaskRepository.insert({
    id,
    projectId,
    createdAt: now,
    fields: {
      code: input.code ?? null,
      title: input.title ?? "",
      description: input.description ?? null,
      evidence: input.evidence ?? null,
      expectedImpact: input.expectedImpact ?? null,
      size: input.size ?? null,
      priority: input.priority ?? "medium",
      status,
      sourceReportId: input.sourceReportId ?? null,
      outcomeNote: input.outcomeNote ?? null,
      statusChangedAt: now,
      doneAt: status === "done" ? now : null,
    },
    urls: urls ?? [],
  });
  return { action: "created", id };
}

/**
 * Creates or updates tasks one by one. A task updates the project's task with
 * its `id`, else the one with its `code`, else it is created. Each task saves
 * on its own, so one bad item comes back as an error without failing the rest.
 */
async function save(params: {
  projectId: string;
  tasks: SeoTaskInput[];
}): Promise<SaveOutcome[]> {
  const { projectId, tasks } = params;
  const now = new Date().toISOString();
  await assertReportsInProject(
    projectId,
    tasks.flatMap((task) => (task.sourceReportId ? [task.sourceReportId] : [])),
  );

  const ids = tasks.flatMap((task) => (task.id ? [task.id] : []));
  const codes = tasks.flatMap((task) => (task.code ? [task.code] : []));
  const [byIdRows, byCodeRows, existingCount] = await Promise.all([
    SeoTaskRepository.findByIds(projectId, ids),
    SeoTaskRepository.findByCodes(projectId, codes),
    SeoTaskRepository.countForProject(projectId),
  ]);
  const byId = new Map(byIdRows.map((row) => [row.id, row]));
  const byCode = new Map(byCodeRows.map((row) => [row.code, row]));
  let remaining = SEO_TASK_MAX_PER_PROJECT - existingCount;
  const seen = new Set<string>();
  const outcomes: SaveOutcome[] = [];

  for (const [index, input] of tasks.entries()) {
    const fail = (message: string) =>
      outcomes.push({ index, action: "error", message });
    const existing = input.id
      ? byId.get(input.id)
      : input.code
        ? byCode.get(input.code)
        : undefined;
    if (input.id && !existing) {
      fail(`Task ${input.id} was not found in this project.`);
      continue;
    }
    const key = existing?.id ?? (input.code ? `code:${input.code}` : null);
    if (key && seen.has(key)) {
      fail("The same task appears more than once in this batch.");
      continue;
    }
    if (key) seen.add(key);
    // Every code in the batch was looked up, so another holder shows here.
    const holder = input.code ? byCode.get(input.code) : undefined;
    if (existing && holder && holder.id !== existing.id) {
      fail(`Code ${input.code} already belongs to another task.`);
      continue;
    }
    if (!existing && !input.title) {
      fail("A new task needs a title.");
      continue;
    }
    if (!existing && remaining <= 0) {
      fail(`This project already has ${SEO_TASK_MAX_PER_PROJECT} tasks.`);
      continue;
    }

    try {
      const { action, id } = await writeTask({
        projectId,
        input,
        existing,
        now,
      });
      if (action === "created") remaining -= 1;
      const task = await SeoTaskRepository.getTask(projectId, id);
      if (task) outcomes.push({ index, action, task });
    } catch (error) {
      // A code renamed earlier in the same batch can still collide.
      if (!isUniqueViolation(error)) throw error;
      fail(`Code ${input.code} already belongs to another task.`);
    }
  }
  return outcomes;
}

async function resolveRef(projectId: string, ref: SeoTaskRef) {
  const [row] =
    "id" in ref
      ? await SeoTaskRepository.findByIds(projectId, [ref.id])
      : await SeoTaskRepository.findByCodes(projectId, [ref.code]);
  if (!row) {
    throw new AppError("NOT_FOUND", "That task was not found in this project.");
  }
  return row;
}

/** Changes a task's status and, when given, its outcome note. */
async function update(params: {
  projectId: string;
  ref: SeoTaskRef;
  status?: SeoTaskStatus;
  outcomeNote?: string | null;
}): Promise<SeoTask> {
  const row = await resolveRef(params.projectId, params.ref);
  const now = new Date().toISOString();
  const fields: Partial<SeoTaskFields> = {
    ...(params.status ? statusFields(row, params.status, now) : {}),
    ...(params.outcomeNote !== undefined
      ? { outcomeNote: params.outcomeNote }
      : {}),
  };
  if (Object.keys(fields).length > 0) {
    await SeoTaskRepository.update({
      id: row.id,
      projectId: params.projectId,
      fields,
    });
  }
  const task = await SeoTaskRepository.getTask(params.projectId, row.id);
  if (!task) throw new AppError("NOT_FOUND");
  return task;
}

export const SeoTaskService = { list, save, update };
