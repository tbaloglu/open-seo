import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryState } from "@/client/components/QueryState";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { SkeletonTableRows } from "@/client/components/SkeletonPresets";
import { DataTableToolbar } from "@/client/components/table/DataTableToolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { featureLabel } from "@/client/features/keywords/components/SerpFeaturesList";
import { getSerpChanges, getSerpRuns } from "@/serverFunctions/serp-history";
import { RANK_TRACKING_HEADER_CLASS } from "../RankTrackingColumns";
import {
  AiOverviewChange,
  PositionChange,
  SetChanges,
} from "./SerpChangeCells";
import {
  HeldBadge,
  NOISE_NOTE,
  runDate,
  SerpMessage,
  serpKey,
  type SerpTrackerProps,
} from "./serpParts";

type Changes = Awaited<ReturnType<typeof getSerpChanges>>;
type KeywordChange = Changes["keywords"][number];
type Run = { id: string; startedAt: string; saved: boolean };

export function SerpChangesTab(props: SerpTrackerProps) {
  const runsQuery = useQuery({
    queryKey: serpKey(props, "runs"),
    queryFn: () => getSerpRuns({ data: props }),
  });
  return (
    <QueryState
      query={runsQuery}
      errorFallback="Failed to load checks"
      loading={<SkeletonTableRows rows={6} columns={6} className="p-4" />}
    >
      {({ runs }) => {
        const saved = runs.filter((run) => run.saved);
        if (runs.length < 2) {
          return (
            <SerpMessage title="Needs two checks">
              This tab compares the latest check with the one before. Run
              another check to see what changed.
            </SerpMessage>
          );
        }
        if (saved.length < 2) {
          return (
            <SerpMessage
              title={
                saved.length === 0
                  ? "No saved SERPs yet"
                  : "Only one check has a saved SERP"
              }
            >
              Checks from before SERP history was saved can&apos;t be compared.
              The next check makes the comparison available.
            </SerpMessage>
          );
        }
        return <ChangesView {...props} runs={runs} />;
      }}
    </QueryState>
  );
}

function ChangesView({ runs, ...props }: SerpTrackerProps & { runs: Run[] }) {
  const saved = runs.filter((run) => run.saved);
  const [toId, setToId] = useState(saved[0].id);
  const [fromId, setFromId] = useState(saved[1].id);
  const [show, setShow] = useState<"changed" | "all">("changed");
  const toIndex = runs.findIndex((run) => run.id === toId);
  const query = useQuery({
    queryKey: serpKey(props, "changes", fromId, toId),
    queryFn: () =>
      getSerpChanges({ data: { ...props, fromRunId: fromId, toRunId: toId } }),
  });

  const pickTo = (id: string) => {
    setToId(id);
    const index = runs.findIndex((run) => run.id === id);
    const fromIndex = runs.findIndex((run) => run.id === fromId);
    if (fromIndex <= index) {
      const next = runs.slice(index + 1).find((run) => run.saved);
      if (next) setFromId(next.id);
    }
  };

  return (
    <>
      <DataTableToolbar
        actions={
          <SegmentedToggle
            showLabels
            items={[
              { value: "changed" as const, icon: null, label: "Changed" },
              { value: "all" as const, icon: null, label: "All keywords" },
            ]}
            value={show}
            onChange={setShow}
          />
        }
      >
        <RunSelect
          label="Earlier check"
          runs={runs.slice(toIndex + 1)}
          value={fromId}
          onChange={setFromId}
        />
        <span className="text-sm text-muted-foreground">→</span>
        <RunSelect
          label="Later check"
          // The oldest check has nothing before it to compare with.
          runs={runs.slice(0, -1)}
          value={toId}
          onChange={pickTo}
        />
      </DataTableToolbar>
      <QueryState
        query={query}
        errorFallback="Failed to load changes"
        loading={<SkeletonTableRows rows={6} columns={6} className="p-4" />}
      >
        {(data) => <ChangesTable data={data} show={show} />}
      </QueryState>
    </>
  );
}

function RunSelect({
  label,
  runs,
  value,
  onChange,
}: {
  label: string;
  runs: Run[];
  value: string;
  onChange: (id: string) => void;
}) {
  const items = runs.map((run) => ({
    value: run.id,
    label: run.saved
      ? runDate(run.startedAt)
      : `${runDate(run.startedAt)} (not saved)`,
  }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} title={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {runs.map((run, index) => (
          <SelectItem key={run.id} value={run.id} disabled={!run.saved}>
            {items[index].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChangesTable({
  data,
  show,
}: {
  data: Changes;
  show: "changed" | "all";
}) {
  const changed = data.keywords.filter((row) => row.changed);
  const rows = show === "changed" ? changed : data.keywords;
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">
        {changed.length} of {data.keywords.length} keywords changed between{" "}
        {runDate(data.runs.from.startedAt)} and{" "}
        {runDate(data.runs.to.startedAt)}. {NOISE_NOTE}
        {data.runs.previous && (
          <>
            {" "}
            <HeldBadge /> means the change was already there on{" "}
            {runDate(data.runs.from.startedAt)}.
          </>
        )}
      </p>
      {rows.length === 0 ? (
        <SerpMessage
          title={
            data.keywords.length === 0
              ? "No keywords to compare"
              : "Nothing changed"
          }
        >
          {data.keywords.length === 0
            ? "These checks have no saved SERP for the same keywords."
            : "Use All keywords to see every keyword."}
        </SerpMessage>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Keyword",
                  "Position",
                  "Top 10",
                  "People Also Ask",
                  "AI Overview",
                  "Features",
                ].map((label) => (
                  <TableHead key={label} className={RANK_TRACKING_HEADER_CLASS}>
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ChangeRow key={row.trackingKeywordId} row={row} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {data.notCompared.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not compared (no saved SERP in both checks):{" "}
          {data.notCompared.join(", ")}
        </p>
      )}
    </div>
  );
}

function ChangeRow({ row }: { row: KeywordChange }) {
  return (
    <TableRow className="align-top">
      <TableCell className="font-medium">{row.keyword}</TableCell>
      <TableCell>
        <PositionChange position={row.position} />
      </TableCell>
      <TableCell>
        <SetChanges added={row.top10.entered} removed={row.top10.left} />
      </TableCell>
      <TableCell className="max-w-80 whitespace-normal">
        <SetChanges
          added={row.questions.added}
          removed={row.questions.removed}
        />
      </TableCell>
      <TableCell>
        <AiOverviewChange aiOverview={row.aiOverview} />
      </TableCell>
      <TableCell>
        <SetChanges
          added={row.featureTypes.added}
          removed={row.featureTypes.removed}
          format={featureLabel}
        />
      </TableCell>
    </TableRow>
  );
}
