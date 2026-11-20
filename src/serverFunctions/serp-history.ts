import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { SerpHistoryService } from "@/server/features/serp-history/services/SerpHistoryService";
import { requireProjectContext } from "@/serverFunctions/middleware";

const trackerSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  device: z.enum(["desktop", "mobile"]),
});

const trackerInput = (
  data: z.infer<typeof trackerSchema>,
  context: {
    projectId: string;
    project: { defaultDevice: "desktop" | "mobile" };
  },
) => ({
  projectId: context.projectId,
  projectDefaultDevice: context.project.defaultDevice,
  trackerId: data.configId,
  device: data.device,
});

export const getSerpRuns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(trackerSchema)
  .handler(({ data, context }) =>
    SerpHistoryService.listRuns(trackerInput(data, context)),
  );

export const getSerpCompetitors = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    trackerSchema.extend({ runs: z.number().int().min(2).max(12).default(6) }),
  )
  .handler(({ data, context }) =>
    SerpHistoryService.getCompetitors({
      ...trackerInput(data, context),
      runs: data.runs,
    }),
  );

export const getSerpChanges = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    trackerSchema.extend({
      fromRunId: z.string().min(1).optional(),
      toRunId: z.string().min(1).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    // The tab lists keywords only; domain movement is the Competitors tab.
    const { runs, keywords, notCompared } = await SerpHistoryService.getChanges(
      {
        ...trackerInput(data, context),
        fromRunId: data.fromRunId,
        toRunId: data.toRunId,
      },
    );
    return { runs, keywords, notCompared };
  });

export const getSerpQuestionsAndSources = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(trackerSchema)
  .handler(({ data, context }) =>
    SerpHistoryService.getQuestionsAndSources(trackerInput(data, context)),
  );

export const getSerpKeywordHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    trackerSchema.extend({
      trackingKeywordId: z.string().uuid(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { checks } = await SerpHistoryService.getKeywordHistory({
      ...trackerInput(data, context),
      trackingKeywordId: data.trackingKeywordId,
      runs: 6,
    });
    return checks;
  });
