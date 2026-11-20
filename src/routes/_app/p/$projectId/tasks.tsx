import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ProjectPageHeader } from "@/client/features/projects/ProjectPageHeader";
import { SeoTasksPage } from "@/client/features/seo-tasks/SeoTasksPage";
import { pageHead } from "@/client/lib/pageHead";
import {
  SEO_TASK_PRIORITIES,
  SEO_TASK_SIZES,
  SEO_TASK_STATUSES,
} from "@/shared/seo-tasks";

const tasksSearchSchema = z.object({
  status: z.enum(SEO_TASK_STATUSES).optional().catch(undefined),
  priority: z.enum(SEO_TASK_PRIORITIES).optional().catch(undefined),
  size: z.enum(SEO_TASK_SIZES).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/p/$projectId/tasks")({
  head: () => pageHead("Tasks"),
  validateSearch: tasksSearchSchema,
  component: TasksRoute,
});

function TasksRoute() {
  const { projectId } = Route.useParams();
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <ProjectPageHeader projectId={projectId} title="Tasks" />
        <SeoTasksPage
          projectId={projectId}
          filters={filters}
          onFiltersChange={(next) =>
            void navigate({ search: (prev) => ({ ...prev, ...next }) })
          }
        />
      </div>
    </div>
  );
}
