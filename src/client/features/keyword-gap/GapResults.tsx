import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import {
  DataTable,
  makeSelectionColumn,
  useDataTable,
  useSelectionAnchor,
} from "@/client/components/table/DataTable";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import {
  TableBulkActionBar,
  TableBulkActionButton,
} from "@/client/components/table/TableBulkActionBar";
import { TablePagination } from "@/client/components/table/TablePagination";
import { Badge } from "@/client/components/ui/badge";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import type { getKeywordGap } from "@/serverFunctions/keyword-gap";
import { saveKeywords } from "@/serverFunctions/keywords";
import { safeHttpUrl } from "@/shared/safe-url";

type GapResult = Extract<
  Awaited<ReturnType<typeof getKeywordGap>>,
  { connected: true }
>;
type GapRow = GapResult["keywords"][number];

const PAGE_SIZES = [50, 100, 200] as const;
const numberFormat = new Intl.NumberFormat("en-US");
const rightAligned = {
  headerClassName: "text-right",
  cellClassName: "text-right tabular-nums",
} as const;
const dash = <span className="text-muted-foreground">—</span>;

export function GapResults({
  projectId,
  result,
}: {
  projectId: string;
  result: GapResult;
}) {
  const { counts } = result;
  const anchorRef = useSelectionAnchor();
  const columns = useMemo(() => buildColumns(anchorRef), [anchorRef]);
  const [rowSelection, setRowSelection] = useState({});
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const table = useDataTable({
    data: result.keywords,
    columns,
    withSorting: true,
    withPagination: true,
    enableRowSelection: true,
    state: { rowSelection, pagination },
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    // The service folds keywords, so each one appears once.
    getRowId: (row) => row.keyword,
    initialState: { sorting: [{ id: "searchVolume", desc: true }] },
  });
  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);
  const save = useSaveGapKeywords(projectId, result, () => setRowSelection({}));

  return (
    <>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {result.competitor} vs {result.siteUrl} · Search Console{" "}
          {result.startDate} to {result.endDate}
        </p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            Compared: {numberFormat.format(counts.competitorTotal)}
          </Badge>
          <Badge variant="destructive">
            Gap: {numberFormat.format(counts.gap)}
          </Badge>
          <Badge variant="secondary">
            No impressions: {numberFormat.format(counts.noImpressions)}
          </Badge>
          <Badge variant="warning">
            Ranking worse than {result.positionThreshold}:{" "}
            {numberFormat.format(counts.belowThreshold)}
          </Badge>
          <Badge variant="success">
            Already ranking (top {result.positionThreshold}):{" "}
            {numberFormat.format(counts.ranking)}
          </Badge>
        </div>
        {counts.returned < counts.gap ? (
          <p className="text-xs text-muted-foreground">
            Showing the top {numberFormat.format(counts.returned)} gap keywords
            by volume.
          </p>
        ) : null}
        {result.searchConsoleTruncated ? (
          <p className="text-xs text-muted-foreground">
            Search Console reached its 100,000-row limit, so some &quot;no
            impressions&quot; rows may be keywords you do rank for.
          </p>
        ) : null}
      </div>

      <DataTable
        table={table}
        empty={
          counts.competitorTotal === 0
            ? {
                title: "No competitor keywords found",
                description: `DataForSEO Labs has no top-${result.maxRank} organic keywords for ${result.competitor} in this country.`,
              }
            : {
                title: "No gap keywords",
                description: `Your site already ranks in the top ${result.positionThreshold} for every compared keyword.`,
              }
        }
        footer={
          result.keywords.length > 0 ? (
            <TablePagination
              page={pagination.pageIndex + 1}
              pageSize={pagination.pageSize}
              pageSizes={PAGE_SIZES}
              totalCount={result.keywords.length}
              hasNextPage={table.getCanNextPage()}
              isLoading={false}
              onPageChange={(page) =>
                setPagination((prev) => ({ ...prev, pageIndex: page - 1 }))
              }
              onPageSizeChange={(pageSize) =>
                setPagination({ pageIndex: 0, pageSize })
              }
            />
          ) : null
        }
      />

      <TableBulkActionBar
        selectedCount={selectedRows.length}
        selectedLabel={selectedRows.length === 1 ? "keyword" : "keywords"}
        onClear={() => setRowSelection({})}
        actions={
          <div className="flex items-center gap-1 px-1.5">
            <TableBulkActionButton
              icon={
                save.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )
              }
              onClick={() => save.mutate(selectedRows)}
              disabled={save.isPending}
            >
              Save keywords
            </TableBulkActionButton>
          </div>
        }
      />
    </>
  );
}

/** Saves gap keywords in the market they were read for. */
function useSaveGapKeywords(
  projectId: string,
  result: GapResult,
  onSaved: () => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    // No metrics: saving bare keywords leaves the richer stats of keywords
    // already saved (CPC, difficulty, intent) untouched.
    mutationFn: (rows: GapRow[]) =>
      saveKeywords({
        data: {
          projectId,
          keywords: rows.map((row) => row.keyword),
          locationCode: result.locationCode,
          languageCode: result.languageCode,
        },
      }),
    onSuccess: (_result, rows) => {
      captureClientEvent("keyword:save", {
        source_feature: "keyword_gap",
        keyword_count: rows.length,
      });
      void queryClient.invalidateQueries({
        queryKey: ["savedKeywords", projectId],
      });
      toast.success(
        `Saved ${rows.length} ${rows.length === 1 ? "keyword" : "keywords"}`,
        {
          description:
            "Use Update keyword stats on Saved Keywords to fetch their volume, difficulty, and CPC.",
        },
      );
      onSaved();
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Couldn't save the keywords"));
    },
  });
}

const columnHelper = createColumnHelper<GapRow>();

function buildColumns(
  anchorRef: ReturnType<typeof useSelectionAnchor>,
): ColumnDef<GapRow>[] {
  return [
    makeSelectionColumn<GapRow>(anchorRef),
    columnHelper.accessor("keyword", {
      enableSorting: false,
      header: () => "Keyword",
      cell: ({ getValue }) => (
        <span className="block max-w-xs truncate" title={getValue()}>
          {getValue()}
        </span>
      ),
    }),
    // Unknown values become undefined so they sort last in both directions.
    columnHelper.accessor((row) => row.searchVolume ?? undefined, {
      id: "searchVolume",
      sortUndefined: "last",
      header: ({ column }) => (
        <SortableHeader column={column} label="Volume" align="right" />
      ),
      cell: ({ getValue }) => {
        const value = getValue();
        return value === undefined ? dash : numberFormat.format(value);
      },
      meta: rightAligned,
    }),
    columnHelper.accessor((row) => row.competitorRank ?? undefined, {
      id: "competitorRank",
      sortUndefined: "last",
      header: ({ column }) => (
        <SortableHeader column={column} label="Their rank" align="right" />
      ),
      cell: ({ getValue }) => getValue() ?? dash,
      meta: rightAligned,
    }),
    columnHelper.accessor((row) => row.ourPosition ?? undefined, {
      id: "ourPosition",
      sortUndefined: "last",
      header: ({ column }) => (
        <SortableHeader column={column} label="Our position" align="right" />
      ),
      cell: ({ getValue }) => {
        const value = getValue();
        return value === undefined ? dash : value.toFixed(1);
      },
      meta: rightAligned,
    }),
    columnHelper.accessor("ourImpressions", {
      enableSorting: false,
      header: () => "Our impressions",
      cell: ({ getValue }) => {
        const value = getValue();
        return value == null ? dash : numberFormat.format(value);
      },
      meta: rightAligned,
    }),
    columnHelper.accessor("competitorUrl", {
      enableSorting: false,
      header: () => "Their page",
      // Labs URLs are third-party data; only http(s) becomes a link.
      cell: ({ getValue }) => {
        const url = getValue();
        const href = url ? safeHttpUrl(url) : null;
        if (!url || !href) return dash;
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="block max-w-sm truncate text-primary underline-offset-4 hover:underline"
            title={url}
          >
            {url}
          </a>
        );
      },
    }),
  ];
}
