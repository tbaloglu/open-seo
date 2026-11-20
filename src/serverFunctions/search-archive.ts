import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { SearchArchiveService } from "@/server/features/search-archive/SearchArchiveService";
import { requireProjectContext } from "@/serverFunctions/middleware";

// The `projectId` in each validator is what triggers project authorization.

const projectSchema = z.object({ projectId: z.string().min(1) });

export const getSearchArchiveStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectSchema)
  .handler(({ context }) => SearchArchiveService.getStatus(context.projectId));

export const startSearchArchive = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectSchema.extend({ mode: z.enum(["backfill", "incremental"]) }),
  )
  .handler(({ data, context }) =>
    SearchArchiveService.start(context.projectId, data.mode),
  );
