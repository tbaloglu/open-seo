import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { SeoTaskService } from "@/server/features/seo-tasks/services/SeoTaskService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  SEO_TASK_MAX_LIST_LIMIT,
  SEO_TASK_MAX_TEXT_CHARS,
  SEO_TASK_PRIORITIES,
  SEO_TASK_SIZES,
  SEO_TASK_STATUSES,
} from "@/shared/seo-tasks";

// The `projectId` in each validator is what triggers project authorization;
// the service filters every task read and write by that project.

const listSchema = z.object({
  projectId: z.string().min(1),
  statuses: z.array(z.enum(SEO_TASK_STATUSES)).optional(),
  priorities: z.array(z.enum(SEO_TASK_PRIORITIES)).optional(),
  sizes: z.array(z.enum(SEO_TASK_SIZES)).optional(),
});

export const listSeoTasks = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listSchema)
  .handler(({ data, context }) =>
    SeoTaskService.list({
      projectId: context.projectId,
      statuses: data.statuses,
      priorities: data.priorities,
      sizes: data.sizes,
      limit: SEO_TASK_MAX_LIST_LIMIT,
      offset: 0,
    }),
  );

const updateSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  status: z.enum(SEO_TASK_STATUSES).optional(),
  outcomeNote: z.string().max(SEO_TASK_MAX_TEXT_CHARS).nullable().optional(),
});

export const updateSeoTask = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateSchema)
  .handler(({ data, context }) =>
    SeoTaskService.update({
      projectId: context.projectId,
      ref: { id: data.taskId },
      status: data.status,
      outcomeNote:
        data.outcomeNote === undefined
          ? undefined
          : data.outcomeNote?.trim() || null,
    }),
  );
