import { z } from "zod";
import { archiveFloor } from "@/server/features/search-archive/archivePlan";
import {
  ARCHIVE_DATASETS as DATASETS,
  SearchArchiveService,
} from "@/server/features/search-archive/SearchArchiveService";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

// The project's own copy of its Search Console and Google Analytics history.
// Every tool authorizes the project first; every archive query is keyed by it.

const integrationsPath = (projectId: string) =>
  `/p/${projectId}/settings/integrations`;

const runOutputSchema = z
  .object({
    runId: z.string(),
    mode: z.enum(["backfill", "incremental"]),
    status: z.enum(["running", "completed", "failed"]),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    rowsWritten: z.number().int(),
    note: z.string().nullable(),
  })
  .passthrough();

type Run = z.infer<typeof runOutputSchema>;

function runLine(run: Run | null): string {
  if (!run) return "No archive run yet.";
  const finished = run.finishedAt ? `, finished ${run.finishedAt}` : "";
  return `Latest run: ${run.mode}, ${run.status} (started ${run.startedAt}${finished}), ${run.rowsWritten} rows written.${run.note ? ` Note: ${run.note}` : ""}`;
}

// ------------------------------------------------------ archive_search_data

const archiveInputSchema = {
  projectId: projectIdSchema,
  mode: z
    .enum(["backfill", "incremental"])
    .describe(
      "backfill: everything Google still has (Search Console's 16 months; Analytics capped at 16 months). incremental: the latest three months. Both skip months already archived for good and re-read the last 4 days, which Google still revises.",
    ),
} as const;

type ArchiveArgs = z.infer<z.ZodObject<typeof archiveInputSchema>>;

export const archiveSearchDataTool = {
  name: "archive_search_data",
  config: {
    title: "Archive Search Console and Analytics data",
    description:
      "Start copying the project's Google Search Console and Google Analytics history into OpenSEO's archive, so it outlives Google's 16-month limit: daily site totals by device, daily page totals, monthly query × page totals (complete months only), daily GA4 sessions, organic sessions and key events, and daily organic sessions per landing page. It runs in the background, one month at a time; check it with get_search_archive_status. If a run is already going, it is not started twice. Safe to run again: months already archived for good are skipped, so a failed backfill resumes. Uses no credits. Read the archive with get_archived_search_performance.",
    inputSchema: archiveInputSchema,
    outputSchema: z.looseObject({
      started: z.boolean(),
      run: runOutputSchema.nullable(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: ArchiveArgs, context) => {
    const { started, run } = await SearchArchiveService.start(
      args.projectId,
      args.mode,
    );
    return mcpResponse({
      text: `${started ? "Archive run started." : "An archive run is already going."} ${runLine(run)} Check progress with get_search_archive_status.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        integrationsPath(args.projectId),
      ),
      structuredContent: { started, run },
    });
  }),
};

// ------------------------------------------------- get_search_archive_status

const statusInputSchema = { projectId: projectIdSchema } as const;
type StatusArgs = z.infer<z.ZodObject<typeof statusInputSchema>>;

export const getSearchArchiveStatusTool = {
  name: "get_search_archive_status",
  config: {
    title: "Get search archive status",
    description:
      "Show the project's search data archive: the latest archive run (mode, status, rows written, notes such as a source that is not connected) and, per source, the first archived month, the last archived day and when it was last fetched. Uses no credits.",
    inputSchema: statusInputSchema,
    outputSchema: z.looseObject({
      run: runOutputSchema.nullable(),
      coverage: z.array(looseObjectOutputSchema),
      connected: z.looseObject({ gsc: z.boolean(), ga4: z.boolean() }),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: StatusArgs, context) => {
    const status = await SearchArchiveService.getStatus(args.projectId);
    const coverage =
      status.coverage.length > 0
        ? status.coverage
            .map(
              (row) =>
                `${row.source}: ${row.firstMonth} → ${row.lastDate} (fetched ${row.lastFetchedAt})`,
            )
            .join("\n")
        : "Nothing archived yet.";
    return mcpResponse({
      text: `${runLine(status.run)}\nSearch Console ${status.connected.gsc ? "connected" : "not connected"}; Google Analytics ${status.connected.ga4 ? "connected" : "not connected"}.\n${coverage}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        integrationsPath(args.projectId),
      ),
      structuredContent: status,
    });
  }),
};

// ------------------------------------------- get_archived_search_performance

const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 1_000;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const archivedInputSchema = {
  projectId: projectIdSchema,
  dataset: z
    .enum(DATASETS)
    .describe(
      "gsc_site: Search Console clicks, impressions and position per day (byDevice splits by device). gsc_pages: per page totals over the range by clicks, or one page per day with `page`. gsc_query_pages: monthly query × page totals (complete months only; filter with page and query). ga4_site: sessions, organic sessions and key events per day. ga4_pages: organic sessions per landing page over the range, or one page per day with `page`.",
    ),
  startDate: dateSchema.describe(
    "First day (YYYY-MM-DD). For gsc_query_pages, the month it falls in.",
  ),
  endDate: dateSchema.describe("Last day (YYYY-MM-DD), inclusive."),
  page: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact page: a full URL as Search Console reports it, or a GA4 landing page path such as /blog/post.",
    ),
  query: z
    .string()
    .min(1)
    .optional()
    .describe("Exact search query (gsc_query_pages only)."),
  byDevice: z
    .boolean()
    .optional()
    .describe("gsc_site only: one row per day and device."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
} as const;

type ArchivedArgs = z.infer<z.ZodObject<typeof archivedInputSchema>>;

const roundRow = (row: Record<string, unknown>) =>
  typeof row.position === "number"
    ? { ...row, position: Math.round(row.position * 10) / 10 }
    : row;

export const getArchivedSearchPerformanceTool = {
  name: "get_archived_search_performance",
  config: {
    title: "Get archived search performance",
    description:
      "Read the project's own archive of Search Console and Google Analytics data (filled by archive_search_data). Use it for anything older than Google's 16 months, such as a year-over-year comparison, and for page or site trends without Google's row limits. Search Console dates are Pacific Time, GA4 dates the property's time zone. Position is an impression-weighted average where rows are summed. The response says which part of the range Google no longer has. For live data inside the last 16 months, get_search_console_performance and the Google Analytics tools are the source. Uses no credits.",
    inputSchema: archivedInputSchema,
    outputSchema: z.looseObject({
      dataset: z.enum(DATASETS),
      startDate: z.string(),
      endDate: z.string(),
      googleKeepsFrom: z.string(),
      rows: z.array(looseObjectOutputSchema),
      rowCount: z.number().int(),
      hasMore: z.boolean(),
      nextOffset: z.number().int().nullable(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ArchivedArgs, context) => {
    if (args.startDate > args.endDate) {
      throw new AppError(
        "VALIDATION_ERROR",
        "startDate must be on or before endDate.",
      );
    }
    const rows = (
      await SearchArchiveService.readArchive({
        ...args,
        limit: args.limit ?? DEFAULT_LIMIT,
        offset: args.offset ?? 0,
      })
    ).map(roundRow);
    const limit = args.limit ?? DEFAULT_LIMIT;
    const paged = args.dataset !== "gsc_site" && args.dataset !== "ga4_site";
    const hasMore = paged && rows.length === limit;
    const nextOffset = hasMore ? (args.offset ?? 0) + rows.length : null;
    const googleKeepsFrom = archiveFloor(new Date().toISOString().slice(0, 10));
    const olderNote =
      args.startDate < googleKeepsFrom
        ? ` Google no longer has the days before ${googleKeepsFrom}; those come only from this archive.`
        : "";
    const header = `${args.dataset} from the archive, ${args.startDate} → ${args.endDate}: ${rows.length} row(s).${olderNote}${hasMore ? ` More: call again with offset=${nextOffset}.` : ""}`;
    const body = rows
      .slice(0, 100)
      .map((row) => Object.values(row).join(" · "))
      .join("\n");
    return mcpResponse({
      text:
        rows.length > 0
          ? `${header}\n${body}${rows.length > 100 ? "\n(first 100 rows shown; all rows are in structuredContent)" : ""}`
          : `${header}\nNothing archived for this range. Run archive_search_data, or check get_search_archive_status.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        integrationsPath(args.projectId),
      ),
      structuredContent: {
        dataset: args.dataset,
        startDate: args.startDate,
        endDate: args.endDate,
        googleKeepsFrom,
        rows,
        rowCount: rows.length,
        hasMore,
        nextOffset,
      },
    });
  }),
};
