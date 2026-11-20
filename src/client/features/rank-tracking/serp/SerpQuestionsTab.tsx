import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryState } from "@/client/components/QueryState";
import { SkeletonTableRows } from "@/client/components/SkeletonPresets";
import { DataTableToolbar } from "@/client/components/table/DataTableToolbar";
import { Input } from "@/client/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { getSerpQuestionsAndSources } from "@/serverFunctions/serp-history";
import { RANK_TRACKING_HEADER_CLASS } from "../RankTrackingColumns";
import {
  OwnBadge,
  runDate,
  SerpMessage,
  serpKey,
  type SerpTrackerProps,
} from "./serpParts";

type Row = { value: string; keywords: string[]; own?: boolean };

export function SerpQuestionsTab(props: SerpTrackerProps) {
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: serpKey(props, "questions"),
    queryFn: () => getSerpQuestionsAndSources({ data: props }),
  });
  const needle = search.trim().toLocaleLowerCase();
  const matches = (row: Row) =>
    !needle ||
    row.value.toLocaleLowerCase().includes(needle) ||
    row.keywords.some((keyword) =>
      keyword.toLocaleLowerCase().includes(needle),
    );

  return (
    <QueryState
      query={query}
      errorFallback="Failed to load questions and sources"
      loading={<SkeletonTableRows rows={6} columns={2} className="p-4" />}
    >
      {(data) =>
        !data.run ? (
          <SerpMessage title="No checks yet">
            Run a check to collect the questions and AI Overview sources Google
            shows for your keywords.
          </SerpMessage>
        ) : !data.run.saved ? (
          <SerpMessage title="No saved SERP for the latest check">
            It ran before SERP history was saved. The next check fills this tab.
          </SerpMessage>
        ) : (
          <>
            <DataTableToolbar>
              <Input
                aria-label="Search questions and sources"
                className="h-7 w-64"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">
                Check of {runDate(data.run.startedAt)} &middot; {data.keywords}{" "}
                keyword{data.keywords === 1 ? "" : "s"}
              </span>
            </DataTableToolbar>
            <div className="grid gap-4 p-4 lg:grid-cols-2">
              <CountTable
                title="People Also Ask"
                column="Question"
                rows={data.questions.filter(matches)}
                total={data.questions.length}
                empty="No People Also Ask questions in this check."
              />
              <CountTable
                title="AI Overview sources"
                column="Domain"
                rows={data.sources.filter(matches)}
                total={data.sources.length}
                empty="No AI Overview in this check."
              />
            </div>
          </>
        )
      }
    </QueryState>
  );
}

function CountTable({
  title,
  column,
  rows,
  total,
  empty,
}: {
  title: string;
  column: string;
  rows: Row[];
  total: number;
  empty: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">
        {title}{" "}
        <span className="font-normal text-muted-foreground">
          {rows.length === total ? total : `${rows.length} of ${total}`}
        </span>
      </h3>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table containerClassName="max-h-[32rem]">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className={RANK_TRACKING_HEADER_CLASS}>
                {column}
              </TableHead>
              <TableHead
                className={`text-right ${RANK_TRACKING_HEADER_CLASS}`}
                title="Tracked keywords whose SERP showed it"
              >
                Keywords
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.value}>
                <TableCell className="whitespace-normal">
                  <span className="flex items-center gap-2">
                    <span className={row.own ? "font-semibold" : undefined}>
                      {row.value}
                    </span>
                    {row.own && <OwnBadge />}
                  </span>
                </TableCell>
                <TableCell
                  className="cursor-help text-right tabular-nums"
                  title={row.keywords.join("\n")}
                >
                  {row.keywords.length}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={2}
                  className="py-8 text-center text-muted-foreground"
                >
                  {total === 0 ? empty : "No matches."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
