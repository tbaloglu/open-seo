import { z } from "zod";
import { SeoTaskService } from "@/server/features/seo-tasks/services/SeoTaskService";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  SEO_TASK_DEFAULT_LIST_LIMIT,
  SEO_TASK_MAX_CODE_CHARS,
  SEO_TASK_MAX_LIST_LIMIT,
  SEO_TASK_MAX_SAVE_BATCH,
  SEO_TASK_MAX_TEXT_CHARS,
  SEO_TASK_MAX_TITLE_CHARS,
  SEO_TASK_MAX_URLS,
  SEO_TASK_PRIORITIES,
  SEO_TASK_SIZES,
  SEO_TASK_STATUSES,
  type SeoTask,
} from "@/shared/seo-tasks";

// The project's SEO to-do list. These tools use only the app database and
// authorize the project before any read or write; every task lookup is also
// filtered by that project.

const tasksPath = (projectId: string) => `/p/${projectId}/tasks`;

const taskOutputSchema = z
  .object({
    id: z.string(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(SEO_TASK_STATUSES),
    priority: z.enum(SEO_TASK_PRIORITIES),
    size: z.enum(SEO_TASK_SIZES).nullable(),
    affectedUrls: z.array(z.string()),
  })
  .passthrough();

const codeSchema = z.string().trim().min(1).max(SEO_TASK_MAX_CODE_CHARS);
const longText = z.string().max(SEO_TASK_MAX_TEXT_CHARS);

function taskLine(task: SeoTask): string {
  const head = [
    task.code ? `[${task.code}]` : null,
    task.title,
    `· ${task.status}`,
    `· ${task.priority}`,
    task.size ? `· ${task.size}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const details = [
    task.affectedUrls.length > 0
      ? `  urls: ${task.affectedUrls.join(", ")}`
      : null,
    task.outcomeNote ? `  outcome: ${task.outcomeNote}` : null,
    `  id: ${task.id}`,
  ].filter(Boolean);
  return [head, ...details].join("\n");
}

// ------------------------------------------------------------ list_seo_tasks

const listInputSchema = {
  projectId: projectIdSchema,
  status: z
    .array(z.enum(SEO_TASK_STATUSES))
    .optional()
    .describe("Only tasks in these statuses. Default: all."),
  priority: z
    .array(z.enum(SEO_TASK_PRIORITIES))
    .optional()
    .describe("Only tasks with these priorities. Default: all."),
  size: z
    .array(z.enum(SEO_TASK_SIZES))
    .optional()
    .describe("Only tasks of these sizes. Default: all."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEO_TASK_MAX_LIST_LIMIT)
    .optional()
    .describe(`Tasks per page (default ${SEO_TASK_DEFAULT_LIST_LIMIT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Pagination offset: nextOffset from the previous page."),
} as const;

type ListArgs = z.infer<z.ZodObject<typeof listInputSchema>>;

export const listSeoTasksTool = {
  name: "list_seo_tasks",
  config: {
    title: "List SEO tasks",
    description:
      "List the project's SEO tasks: the to-do list written from reports, with each task's code, title, description, evidence, affected URLs, expected impact, size (S/M/L), priority, status (proposed, selected, in_progress, done, dropped), source report, dates and outcome note. Sorted by priority, then code. Filter by status, priority or size; page with limit and offset. Also returns how many tasks are in each status. Uses no credits.",
    inputSchema: listInputSchema,
    outputSchema: z.looseObject({
      tasks: z.array(taskOutputSchema),
      total: z.number().int(),
      countsByStatus: z.record(z.string(), z.number().int()),
      hasMore: z.boolean(),
      nextOffset: z.number().int().nullable(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ListArgs, context) => {
    const result = await SeoTaskService.list({
      projectId: args.projectId,
      statuses: args.status,
      priorities: args.priority,
      sizes: args.size,
      limit: args.limit ?? SEO_TASK_DEFAULT_LIST_LIMIT,
      offset: args.offset ?? 0,
    });
    const counts = SEO_TASK_STATUSES.map(
      (status) => `${status} ${result.countsByStatus[status] ?? 0}`,
    ).join(", ");
    const header = `${result.total} matching task(s); project totals: ${counts}.${result.hasMore ? ` More: call again with offset=${result.nextOffset}.` : ""}`;
    return mcpResponse({
      text:
        result.tasks.length > 0
          ? `${header}\n\n${result.tasks.map(taskLine).join("\n")}`
          : `${header}\nNo tasks match.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        tasksPath(args.projectId),
      ),
      structuredContent: result,
    });
  }),
};

// ------------------------------------------------------------ save_seo_tasks

const saveTaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe("Update this task (an id from list_seo_tasks)."),
  code: codeSchema
    .nullable()
    .optional()
    .describe(
      "The report's label for the task, such as 'A1'. Unique in the project: without an id, a task with this code is updated instead of created.",
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(SEO_TASK_MAX_TITLE_CHARS)
    .optional()
    .describe("Short imperative title. Required for a new task."),
  description: longText.nullable().optional().describe("What to do and how."),
  evidence: longText
    .nullable()
    .optional()
    .describe(
      "The data the task is based on: GSC numbers, SERP findings, audit issues.",
    ),
  affectedUrls: z
    .array(z.string().trim().min(1).max(2048))
    .max(SEO_TASK_MAX_URLS)
    .optional()
    .describe("Pages the task touches. Replaces the task's list when given."),
  expectedImpact: longText.nullable().optional(),
  size: z.enum(SEO_TASK_SIZES).nullable().optional().describe("Effort."),
  priority: z
    .enum(SEO_TASK_PRIORITIES)
    .optional()
    .describe("Default medium for a new task."),
  status: z
    .enum(SEO_TASK_STATUSES)
    .optional()
    .describe(
      "Default proposed for a new task. Usually left unset: the owner selects tasks; use update_seo_task_status for progress.",
    ),
  sourceReportId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("The report (from list_reports) this task came from."),
  outcomeNote: longText
    .nullable()
    .optional()
    .describe("The measured effect after the task was done."),
});

const saveInputSchema = {
  projectId: projectIdSchema,
  tasks: z
    .array(saveTaskSchema)
    .min(1)
    .max(SEO_TASK_MAX_SAVE_BATCH)
    .describe(
      "Tasks to create or update. Fields left out of an update keep their value.",
    ),
} as const;

type SaveArgs = z.infer<z.ZodObject<typeof saveInputSchema>>;

export const saveSeoTasksTool = {
  name: "save_seo_tasks",
  config: {
    title: "Save SEO tasks",
    description: `Create or update up to ${SEO_TASK_MAX_SAVE_BATCH} SEO tasks in the project's to-do list. Each task updates the task with its id; without an id, the task with the same code; otherwise it is created as 'proposed'. Use it after writing a report: one task per recommendation, with its code, evidence, affected URLs, expected impact, size and priority, and sourceReportId set to the saved report. Each task saves on its own; one that fails comes back in results with action 'error' and does not stop the rest. Uses no credits.`,
    inputSchema: saveInputSchema,
    outputSchema: z.looseObject({
      results: z.array(
        z
          .object({
            index: z.number().int(),
            action: z.enum(["created", "updated", "error"]),
            task: taskOutputSchema.optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      ),
      created: z.number().int(),
      updated: z.number().int(),
      failed: z.number().int(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: SaveArgs, context) => {
    const results = await SeoTaskService.save({
      projectId: args.projectId,
      tasks: args.tasks,
    });
    const tally = (action: string) =>
      results.filter((result) => result.action === action).length;
    const created = tally("created");
    const updated = tally("updated");
    const failed = tally("error");
    const lines = results.map((result) =>
      result.action === "error"
        ? `#${result.index}: error: ${result.message}`
        : `#${result.index}: ${result.action} ${result.task.code ? `[${result.task.code}] ` : ""}${result.task.title} (${result.task.id})`,
    );
    return mcpResponse({
      text: `Saved tasks: ${created} created, ${updated} updated, ${failed} failed.\n${lines.join("\n")}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        tasksPath(args.projectId),
      ),
      structuredContent: { results, created, updated, failed },
    });
  }),
};

// ---------------------------------------------------- update_seo_task_status

const updateInputSchema = {
  projectId: projectIdSchema,
  taskId: z
    .string()
    .min(1)
    .optional()
    .describe("The task's id. Give this or code."),
  code: codeSchema.optional().describe("The task's code, such as 'A1'."),
  status: z
    .enum(SEO_TASK_STATUSES)
    .describe(
      "New status. done stamps done_at; leaving done clears it. Any status may follow any other.",
    ),
  outcomeNote: longText
    .nullable()
    .optional()
    .describe(
      "The measured effect, usually with done: before/after GSC numbers and the dates compared. null clears it.",
    ),
} as const;

type UpdateArgs = z.infer<z.ZodObject<typeof updateInputSchema>>;

export const updateSeoTaskStatusTool = {
  name: "update_seo_task_status",
  config: {
    title: "Update an SEO task's status",
    description:
      "Change one SEO task's status (proposed, selected, in_progress, done, dropped) and optionally its outcome note. Address the task by taskId or by its code. Uses no credits.",
    inputSchema: updateInputSchema,
    outputSchema: z.looseObject({
      task: taskOutputSchema,
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: UpdateArgs, context) => {
    const ref = args.taskId
      ? { id: args.taskId }
      : args.code
        ? { code: args.code }
        : null;
    if (!ref || (args.taskId && args.code)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Give exactly one of taskId or code.",
      );
    }
    const task = await SeoTaskService.update({
      projectId: args.projectId,
      ref,
      status: args.status,
      outcomeNote: args.outcomeNote,
    });
    return mcpResponse({
      text: `Task updated.\n${taskLine(task)}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        tasksPath(args.projectId),
      ),
      structuredContent: { task },
    });
  }),
};
