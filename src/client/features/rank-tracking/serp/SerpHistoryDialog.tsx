import { useState } from "react";
import { reverse } from "remeda";
import { useQuery } from "@tanstack/react-query";
import { QueryState } from "@/client/components/QueryState";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { SerpFeaturesList } from "@/client/features/keywords/components/SerpFeaturesList";
import { getSerpKeywordHistory } from "@/serverFunctions/serp-history";
import { isOwnSite } from "@/shared/serp-history";
import {
  NOISE_NOTE,
  runDate,
  SerpMessage,
  serpKey,
  type SerpTrackerProps,
} from "./serpParts";

type Check = Awaited<ReturnType<typeof getSerpKeywordHistory>>[number];

const RANKS = Array.from({ length: 10 }, (_, index) => index + 1);

/** One keyword's latest checks: our position, the top 10 and the SERP features. */
export function SerpHistoryDialog({
  target,
  domain,
  onClose,
  ...props
}: SerpTrackerProps & {
  target: { trackingKeywordId: string; keyword: string };
  domain: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: serpKey(props, "keyword", target.trackingKeywordId),
    queryFn: () =>
      getSerpKeywordHistory({
        data: {
          ...props,
          trackingKeywordId: target.trackingKeywordId,
        },
      }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{target.keyword}</DialogTitle>
          <DialogDescription className="text-xs">
            {domain} &middot; {props.device === "mobile" ? "Mobile" : "Desktop"}{" "}
            &middot; SERP of the latest checks. {NOISE_NOTE}
          </DialogDescription>
        </DialogHeader>
        <QueryState
          query={query}
          errorFallback="Failed to load SERP history"
          loading={<Skeleton className="h-72 w-full" />}
        >
          {(checks) =>
            checks.length === 0 ? (
              <SerpMessage title="No checks yet">
                Run a check to see what Google shows for this keyword.
              </SerpMessage>
            ) : (
              <SerpHistory checks={checks} domain={domain} />
            )
          }
        </QueryState>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function SerpHistory({ checks, domain }: { checks: Check[]; domain: string }) {
  // Oldest on the left, like the history matrix.
  const columns = reverse(checks);
  const [selected, setSelected] = useState<string | null>(null);
  // The picked check while it is still listed and saved, else the newest saved.
  const selectedCheck =
    checks.find((check) => check.saved && check.runId === selected) ??
    checks.find((check) => check.saved);

  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto">
      {!checks.some((check) => check.saved) && (
        <p className="text-sm text-muted-foreground">
          These checks ran before SERP history was saved, so only the position
          is known. The next check saves the full SERP.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 text-xs">#</TableHead>
              {columns.map((check) => (
                <TableHead key={check.runId} className="min-w-36 text-xs">
                  {check.saved ? (
                    <button
                      type="button"
                      aria-pressed={check.runId === selectedCheck?.runId}
                      className="text-left decoration-dotted underline-offset-2 hover:underline aria-pressed:font-semibold aria-pressed:text-foreground"
                      onClick={() => setSelected(check.runId)}
                      title="Show this check's SERP features"
                    >
                      {runDate(check.checkedAt)}
                    </button>
                  ) : (
                    <span title="SERP features were not saved for this check.">
                      {runDate(check.checkedAt)}
                    </span>
                  )}
                  <div className="font-normal text-muted-foreground">
                    You: {check.position ?? "not found"}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {RANKS.map((rank) => (
              <TableRow key={rank}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {rank}
                </TableCell>
                {columns.map((check) => {
                  if (!check.saved) {
                    return (
                      <TableCell
                        key={check.runId}
                        className="text-xs text-muted-foreground"
                      >
                        {rank === 1 ? "Not saved" : ""}
                      </TableCell>
                    );
                  }
                  const result = check.top10.find((row) => row.rank === rank);
                  const site = result?.domain ?? null;
                  return (
                    <TableCell
                      key={check.runId}
                      className={`max-w-48 truncate text-xs ${isOwnSite(site, domain) ? "bg-primary/10 font-semibold" : ""}`}
                      title={result?.title ?? result?.url ?? undefined}
                    >
                      {result ? (site ?? "(unknown)") : ""}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {selectedCheck && (
        <div className="rounded-lg border border-border">
          <p className="px-4 py-2 text-xs text-muted-foreground">
            {runDate(selectedCheck.checkedAt)} &middot; click a date above to
            see another check
          </p>
          {selectedCheck.features.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No SERP features in this check.
            </p>
          ) : (
            <SerpFeaturesList
              features={selectedCheck.features.map((feature) => ({
                type: feature.type,
                details: feature.values.flatMap((entry) =>
                  entry.value ? [entry.value] : [],
                ),
              }))}
            />
          )}
        </div>
      )}
    </div>
  );
}
