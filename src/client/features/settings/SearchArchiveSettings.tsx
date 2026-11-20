import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { CardShell } from "@/client/components/CardShell";
import { QueryState } from "@/client/components/QueryState";
import { Button } from "@/client/components/ui/button";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getSearchArchiveStatus,
  startSearchArchive,
} from "@/serverFunctions/search-archive";

const SOURCE_LABELS: Record<string, string> = {
  gsc_site: "Search Console, site by day",
  gsc_page: "Search Console, pages by day",
  gsc_query_page: "Search Console, queries × pages by month",
  ga4_site: "Analytics, site by day",
  ga4_page: "Analytics, landing pages by day",
};

/**
 * The project's own copy of its Search Console and Analytics history, kept
 * past Google's 16 months: what it holds and when it last ran.
 */
export function SearchArchiveSettings({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["search-archive-status", projectId];
  const statusQuery = useQuery({
    queryKey,
    queryFn: () => getSearchArchiveStatus({ data: { projectId } }),
    staleTime: 0,
    // Follow a running archive until it finishes.
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 15_000 : false,
  });
  const startMutation = useMutation({
    mutationFn: () =>
      startSearchArchive({ data: { projectId, mode: "backfill" } }),
    onSuccess: (result) => {
      if (result.started) toast.success("Archiving started.");
      else if (result.run?.status === "running")
        toast.info("An archive run is already going.");
      else toast.error("Couldn't start archiving. Try again.");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't start archiving.")),
  });

  return (
    <CardShell
      title="Search data archive"
      icon={<Archive className="size-4" />}
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={
            startMutation.isPending ||
            statusQuery.data?.run?.status === "running" ||
            !(
              statusQuery.data?.connected.gsc || statusQuery.data?.connected.ga4
            )
          }
          onClick={() => startMutation.mutate()}
        >
          Archive now
        </Button>
      }
    >
      <QueryState
        query={statusQuery}
        errorFallback="Couldn't load the archive."
      >
        {({ run, coverage, connected }) => (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Google keeps Search Console data for 16 months. OpenSEO keeps its
              own copy so older months stay comparable.
            </p>
            {!connected.gsc && !connected.ga4 ? (
              <p>Connect Search Console or Google Analytics to archive.</p>
            ) : null}
            {run ? (
              <p>
                Last run: {run.status} ({run.mode}), started{" "}
                {run.startedAt.slice(0, 16).replace("T", " ")}
                {run.finishedAt
                  ? `, finished ${run.finishedAt.slice(0, 16).replace("T", " ")}`
                  : ""}
                , {run.rowsWritten.toLocaleString()} rows.
                {run.note ? ` ${run.note}` : ""}
              </p>
            ) : (
              <p>Not archived yet.</p>
            )}
            {coverage.length > 0 ? (
              <ul className="space-y-0.5 text-muted-foreground">
                {coverage.map((row) => (
                  <li key={row.source}>
                    {SOURCE_LABELS[row.source] ?? row.source}: {row.firstMonth}{" "}
                    → {row.lastDate}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </QueryState>
    </CardShell>
  );
}
