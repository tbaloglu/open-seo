import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { TopicWordsService } from "@/server/features/topic-words/services/TopicWordsService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { topicWordsSchema } from "@/shared/topic-words";

// The `projectId` in each validator is what triggers project authorization.

export const getTopicWords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(({ context }) => TopicWordsService.getTopicWords(context.projectId));

export const setTopicWords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({ projectId: z.string().min(1), words: topicWordsSchema }),
  )
  .handler(({ data, context }) =>
    TopicWordsService.setTopicWords(context.projectId, data.words),
  );
