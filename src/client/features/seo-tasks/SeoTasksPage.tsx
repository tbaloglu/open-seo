import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { QueryState } from "@/client/components/QueryState";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent } from "@/client/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/client/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { Textarea } from "@/client/components/ui/textarea";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { listSeoTasks, updateSeoTask } from "@/serverFunctions/seo-tasks";
import {
  SEO_TASK_PRIORITIES,
  SEO_TASK_PRIORITY_LABELS,
  SEO_TASK_SIZES,
  SEO_TASK_STATUS_LABELS,
  SEO_TASK_STATUSES,
  type SeoTask,
  type SeoTaskPriority,
  type SeoTaskSize,
  type SeoTaskStatus,
} from "@/shared/seo-tasks";

type SeoTaskFilters = {
  status?: SeoTaskStatus;
  priority?: SeoTaskPriority;
  size?: SeoTaskSize;
};

// Groups in working order: what is underway first, closed work last.
const GROUP_ORDER: SeoTaskStatus[] = [
  "in_progress",
  "selected",
  "proposed",
  "done",
  "dropped",
];

const PRIORITY_VARIANT = {
  high: "destructive",
  medium: "warning",
  low: "secondary",
} as const;

const ALL = "all";

const seoTasksKey = (projectId: string) => ["seo-tasks", projectId] as const;

function FilterSelect<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  labels?: Record<T, string>;
  onChange: (value: T | undefined) => void;
}) {
  const items = [
    { value: ALL, label: `All ${label.toLowerCase()}` },
    ...options.map((option) => ({
      value: option,
      label: labels?.[option] ?? option,
    })),
  ];
  return (
    <Select
      items={items}
      value={value ?? ALL}
      onValueChange={(next) => {
        if (next == null) return;
        onChange(options.find((option) => option === next));
      }}
    >
      <SelectTrigger size="sm" className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Detail({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-sm whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function OutcomeEditor({
  task,
  saving,
  onSave,
}: {
  task: SeoTask;
  saving: boolean;
  onSave: (note: string) => void;
}) {
  const [draft, setDraft] = useState(task.outcomeNote ?? "");
  const changed = draft.trim() !== (task.outcomeNote ?? "");
  return (
    <div className="space-y-2">
      <label
        className="text-xs font-medium text-muted-foreground"
        htmlFor={`outcome-${task.id}`}
      >
        Outcome note
      </label>
      <Textarea
        id={`outcome-${task.id}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What changed after this was done (before/after numbers, dates)."
        rows={3}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || saving}
        onClick={() => onSave(draft)}
      >
        Save note
      </Button>
    </div>
  );
}

function TaskCard({
  task,
  projectId,
  updating,
  onUpdate,
}: {
  task: SeoTask;
  projectId: string;
  updating: boolean;
  onUpdate: (fields: {
    status?: SeoTaskStatus;
    outcomeNote?: string | null;
  }) => void;
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {task.code ? <Badge variant="outline">{task.code}</Badge> : null}
              <Badge variant={PRIORITY_VARIANT[task.priority]}>
                {SEO_TASK_PRIORITY_LABELS[task.priority]}
              </Badge>
              {task.size ? (
                <Badge variant="secondary">Size {task.size}</Badge>
              ) : null}
            </div>
            <h3 className="font-medium leading-snug">{task.title}</h3>
          </div>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Status"
          >
            {SEO_TASK_STATUSES.map((status) => (
              <Button
                key={status}
                size="xs"
                variant={task.status === status ? "default" : "outline"}
                aria-pressed={task.status === status}
                disabled={updating}
                onClick={() => {
                  if (task.status !== status) onUpdate({ status });
                }}
              >
                {SEO_TASK_STATUS_LABELS[status]}
              </Button>
            ))}
          </div>
        </div>
        {task.description ? (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {task.description}
          </p>
        ) : null}
        <Collapsible>
          <CollapsibleTrigger
            render={<Button size="xs" variant="ghost" className="-ml-2" />}
          >
            Details
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            <Detail label="Evidence" text={task.evidence} />
            <Detail label="Expected impact" text={task.expectedImpact} />
            {task.affectedUrls.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Affected URLs
                </p>
                <ul className="space-y-0.5">
                  {task.affectedUrls.map((url) => (
                    <li key={url}>
                      <SafeExternalLink
                        url={url}
                        label={url}
                        className="inline-flex items-center gap-1 text-sm break-all text-primary hover:underline"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {task.sourceReportId ? (
              <Link
                to="/p/$projectId/reports/$reportId"
                params={{ projectId, reportId: task.sourceReportId }}
                className="text-sm text-primary hover:underline"
              >
                Open source report
              </Link>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Added {task.createdAt.slice(0, 10)} · status changed{" "}
              {task.statusChangedAt.slice(0, 10)}
              {task.doneAt ? ` · done ${task.doneAt.slice(0, 10)}` : ""}
            </p>
            <OutcomeEditor
              // A saved note from elsewhere resets the draft.
              key={task.outcomeNote ?? ""}
              task={task}
              saving={updating}
              onSave={(note) => onUpdate({ outcomeNote: note })}
            />
          </CollapsibleContent>
        </Collapsible>
        {task.outcomeNote ? (
          <Detail label="Outcome" text={task.outcomeNote} />
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SeoTasksPage({
  projectId,
  filters,
  onFiltersChange,
}: {
  projectId: string;
  filters: SeoTaskFilters;
  onFiltersChange: (filters: Partial<SeoTaskFilters>) => void;
}) {
  const queryClient = useQueryClient();
  const tasksQuery = useQuery({
    queryKey: [...seoTasksKey(projectId), filters],
    queryFn: () =>
      listSeoTasks({
        data: {
          projectId,
          statuses: filters.status ? [filters.status] : undefined,
          priorities: filters.priority ? [filters.priority] : undefined,
          sizes: filters.size ? [filters.size] : undefined,
        },
      }),
    // Agents add tasks over MCP; show the list as it is now.
    staleTime: 0,
  });

  const updateMutation = useMutation({
    mutationFn: (input: {
      taskId: string;
      status?: SeoTaskStatus;
      outcomeNote?: string | null;
    }) => updateSeoTask({ data: { projectId, ...input } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: seoTasksKey(projectId) }),
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't update the task.")),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Statuses"
          value={filters.status}
          options={SEO_TASK_STATUSES}
          labels={SEO_TASK_STATUS_LABELS}
          onChange={(status) => onFiltersChange({ status })}
        />
        <FilterSelect
          label="Priorities"
          value={filters.priority}
          options={SEO_TASK_PRIORITIES}
          labels={SEO_TASK_PRIORITY_LABELS}
          onChange={(priority) => onFiltersChange({ priority })}
        />
        <FilterSelect
          label="Sizes"
          value={filters.size}
          options={SEO_TASK_SIZES}
          onChange={(size) => onFiltersChange({ size })}
        />
      </div>
      <QueryState query={tasksQuery} errorFallback="Couldn't load tasks.">
        {(data) => {
          const counts = SEO_TASK_STATUSES.map(
            (status) =>
              `${SEO_TASK_STATUS_LABELS[status]} ${data.countsByStatus[status] ?? 0}`,
          ).join(" · ");
          if (data.tasks.length === 0) {
            return (
              <p className="text-sm text-muted-foreground">
                {data.total === 0 &&
                !filters.status &&
                !filters.priority &&
                !filters.size
                  ? "No tasks yet. Agents add them with the save_seo_tasks tool when they write a report."
                  : "No tasks match these filters."}
              </p>
            );
          }
          return (
            <div className="space-y-6">
              <p className="text-sm text-muted-foreground">{counts}</p>
              {GROUP_ORDER.map((status) => {
                const tasks = data.tasks.filter(
                  (task) => task.status === status,
                );
                if (tasks.length === 0) return null;
                return (
                  <section key={status} className="space-y-2">
                    <h2 className="text-sm font-semibold">
                      {SEO_TASK_STATUS_LABELS[status]} ({tasks.length})
                    </h2>
                    {tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        projectId={projectId}
                        updating={
                          updateMutation.isPending &&
                          updateMutation.variables.taskId === task.id
                        }
                        onUpdate={(fields) =>
                          updateMutation.mutate({ taskId: task.id, ...fields })
                        }
                      />
                    ))}
                  </section>
                );
              })}
              {data.hasMore ? (
                <p className="text-sm text-muted-foreground">
                  Showing the first {data.tasks.length} of {data.total} tasks.
                  Narrow the filters to see the rest.
                </p>
              ) : null}
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
