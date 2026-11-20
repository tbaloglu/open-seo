import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { reverse, sortBy } from "remeda";
import { QueryState } from "@/client/components/QueryState";
import { SkeletonTableRows } from "@/client/components/SkeletonPresets";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { getSerpCompetitors } from "@/serverFunctions/serp-history";
import { RANK_TRACKING_HEADER_CLASS } from "../RankTrackingColumns";
import {
  OwnBadge,
  runDate,
  SerpMessage,
  serpKey,
  type SerpTrackerProps,
} from "./serpParts";

const RUNS = 6;
const PAGE = 50;

type Competitors = Awaited<ReturnType<typeof getSerpCompetitors>>;
type SortId = "domain" | "latest" | "change";

export function SerpCompetitorsTab(props: SerpTrackerProps) {
  const query = useQuery({
    queryKey: serpKey(props, "competitors", RUNS),
    queryFn: () => getSerpCompetitors({ data: { ...props, runs: RUNS } }),
  });
  return (
    <QueryState
      query={query}
      errorFallback="Failed to load competitors"
      loading={<SkeletonTableRows rows={6} columns={5} className="p-4" />}
    >
      {(data) =>
        data.runs.length === 0 ? (
          <SerpMessage title="No saved SERPs yet">
            {data.unsavedRuns > 0
              ? "Earlier checks ran before SERP history was saved. The next check fills this tab."
              : "Run a check to see which sites rank for your keywords."}
          </SerpMessage>
        ) : (
          <CompetitorsTable data={data} />
        )
      }
    </QueryState>
  );
}

function CompetitorsTable({ data }: { data: Competitors }) {
  const [sort, setSort] = useState<{ id: SortId; desc: boolean }>({
    id: "latest",
    desc: true,
  });
  const [showAll, setShowAll] = useState(false);
  const hasChange = data.runs.length > 1;
  const rows = useMemo(() => {
    if (sort.id === "latest") {
      // The service already orders by latest count, then by all checks.
      return sort.desc ? data.domains : reverse(data.domains);
    }
    const direction = sort.desc ? "desc" : "asc";
    // Stable, so ties keep the service's order.
    return sort.id === "domain"
      ? sortBy(data.domains, [(row) => row.domain, direction])
      : sortBy(data.domains, [
          (row) => row.change ?? Number.NEGATIVE_INFINITY,
          direction,
        ]);
  }, [data.domains, sort]);
  const visible = showAll ? rows : rows.slice(0, PAGE);

  const column = (id: SortId) => ({
    getIsSorted: () =>
      sort.id === id
        ? sort.desc
          ? ("desc" as const)
          : ("asc" as const)
        : false,
    getToggleSortingHandler: () => () =>
      setSort((current) =>
        current.id === id
          ? { id, desc: !current.desc }
          : { id, desc: id !== "domain" },
      ),
  });

  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">
        Tracked keywords where each site ranks in the top 10, per check.
        {!hasChange && " Run another check to see changes."}
        {data.unsavedRuns > 0 &&
          ` ${data.unsavedRuns} older check${data.unsavedRuns === 1 ? "" : "s"} ran before SERP history was saved.`}
      </p>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <SortableHeader
                  column={column("domain")}
                  label="Domain"
                  className={RANK_TRACKING_HEADER_CLASS}
                />
              </TableHead>
              {data.runs.map((run, index) => {
                const latest = index === data.runs.length - 1;
                return (
                  <TableHead
                    key={run.id}
                    className="text-right"
                    title={`${run.keywords} keyword${run.keywords === 1 ? "" : "s"} saved`}
                  >
                    {latest ? (
                      <SortableHeader
                        column={column("latest")}
                        label={runDate(run.startedAt)}
                        className={RANK_TRACKING_HEADER_CLASS}
                        align="right"
                      />
                    ) : (
                      <span className={RANK_TRACKING_HEADER_CLASS}>
                        {runDate(run.startedAt)}
                      </span>
                    )}
                  </TableHead>
                );
              })}
              {hasChange && (
                <TableHead className="text-right">
                  <SortableHeader
                    column={column("change")}
                    label="Change"
                    className={RANK_TRACKING_HEADER_CLASS}
                    align="right"
                  />
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow
                key={row.domain}
                className={row.own ? "bg-primary/5" : undefined}
              >
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className={row.own ? "font-semibold" : undefined}>
                      {row.domain}
                    </span>
                    {row.own && <OwnBadge />}
                    {row.status === "entered" && (
                      <Badge
                        size="sm"
                        className="bg-success/20 text-success"
                        title="Not in the top 10 for any keyword in the check before"
                      >
                        New
                      </Badge>
                    )}
                    {row.status === "left" && (
                      <Badge
                        size="sm"
                        className="bg-warning/20 text-warning"
                        title="No longer in the top 10 for any keyword"
                      >
                        Left
                      </Badge>
                    )}
                  </span>
                </TableCell>
                {row.counts.map((count, index) => (
                  <TableCell
                    key={data.runs[index].id}
                    className={`text-right tabular-nums ${count === 0 ? "text-muted-foreground" : ""} ${index === row.counts.length - 1 ? "font-medium" : ""}`}
                  >
                    {count}
                  </TableCell>
                ))}
                {hasChange && (
                  <TableCell className="text-right">
                    <ChangeCell change={row.change} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > PAGE && (
        <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${rows.length} domains`}
        </Button>
      )}
    </div>
  );
}

function ChangeCell({ change }: { change: number | null }) {
  if (!change) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${change > 0 ? "bg-success/20 text-success" : "bg-warning/20 text-warning"}`}
    >
      {change > 0 ? `+${change}` : change}
    </span>
  );
}
