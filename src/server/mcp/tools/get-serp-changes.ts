import { z } from "zod";
import { SerpHistoryService } from "@/server/features/serp-history/services/SerpHistoryService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { projectIdSchema } from "@/server/mcp/schemas";

const MAX_DOMAINS = 50;

const inputSchema = {
  projectId: projectIdSchema,
  trackerId: z
    .string()
    .uuid()
    .describe("Rank tracker config ID from get_rank_tracker."),
  fromRunId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The earlier completed check to compare. Defaults to the check before toRunId.",
    ),
  toRunId: z
    .string()
    .min(1)
    .optional()
    .describe("The later completed check. Defaults to the latest one."),
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe(
      "Device to compare. Defaults to the tracker's only device, or the project's default device for a tracker that checks both.",
    ),
  onlyChanged: z
    .boolean()
    .optional()
    .describe(
      "Return only keywords with a change. Default true; false also lists unchanged keywords.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Keyword row offset. Defaults to 0."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe("Keyword rows per page. Defaults to 100."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const changeSchema = z
  .object({ value: z.string(), persisted: z.boolean() })
  .passthrough();
const addedRemovedSchema = z
  .object({ added: z.array(changeSchema), removed: z.array(changeSchema) })
  .passthrough();
const statusSchema = z.enum(["unchanged", "changed", "held"]);
const aiOverviewStateSchema = z.enum(["cited", "not_cited", "absent"]);
const runSchema = z
  .object({ id: z.string(), startedAt: z.string() })
  .passthrough();

type Change = z.infer<typeof changeSchema>;
type Changes = Awaited<ReturnType<typeof SerpHistoryService.getChanges>>;
type DomainRow = Changes["domains"][number];

const day = (run: { startedAt: string }) => run.startedAt.slice(0, 10);

/** "a.com, b.com (held)" — held marks a change that persisted two checks. */
function listChanges(changes: Change[]) {
  return changes
    .map((change) => `${change.value}${change.persisted ? " (held)" : ""}`)
    .join(", ");
}

const held = (status: string) => (status === "held" ? " (held)" : "");
const states = (values: Array<string | number | null>) =>
  values.map((value) => value ?? "—").join(" → ");

function keywordLines(keyword: Changes["keywords"][number]) {
  const { position, top10, questions, aiOverview, featureTypes } = keyword;
  const lines = [`## ${keyword.keyword}`];
  if (position.status !== "unchanged") {
    lines.push(
      `Position: ${states(position.status === "held" ? [position.previous, position.from, position.to] : [position.from, position.to])}${held(position.status)}`,
    );
  }
  if (top10.entered.length > 0)
    lines.push(`Entered top 10: ${listChanges(top10.entered)}`);
  if (top10.left.length > 0)
    lines.push(`Left top 10: ${listChanges(top10.left)}`);
  if (questions.added.length > 0)
    lines.push(`New questions: ${listChanges(questions.added)}`);
  if (questions.removed.length > 0)
    lines.push(`Removed questions: ${listChanges(questions.removed)}`);
  if (aiOverview.status !== "unchanged") {
    lines.push(
      `AI Overview: ${states(aiOverview.status === "held" ? [aiOverview.previous, aiOverview.from, aiOverview.to] : [aiOverview.from, aiOverview.to])}${held(aiOverview.status)}`,
    );
  }
  if (featureTypes.added.length > 0)
    lines.push(`New features: ${listChanges(featureTypes.added)}`);
  if (featureTypes.removed.length > 0)
    lines.push(`Removed features: ${listChanges(featureTypes.removed)}`);
  return lines;
}

export const getSerpChangesTool = {
  name: "get_serp_changes",
  config: {
    title: "Get SERP changes",
    description:
      "Compare what Google showed for every keyword of a rank tracker between two completed checks, by default the latest two. Per keyword: the tracked site's position, domains that entered or left the top 10, People Also Ask questions added or removed, whether the site is an AI Overview source (cited / not_cited / absent), and SERP feature types added or removed. Also domains whose top-10 count (keywords they rank for) changed, which shows who is gaining or losing. One check is one read and Google varies between reads, so a change seen only in the latest check (`persisted: false`, status `changed`) may be noise. When the check before `from` was saved, a change between it and `from` that the latest check still shows has `persisted: true` (status `held`); lead with those. Uses no credits. Only checks saved since SERP history began can be compared; keywords without a saved SERP in both checks are listed in `notCompared`.",
    inputSchema,
    outputSchema: z
      .object({
        trackerId: z.string(),
        domain: z.string(),
        device: z.enum(["desktop", "mobile"]),
        runs: z
          .object({
            previous: runSchema.nullable(),
            from: runSchema,
            to: runSchema,
          })
          .passthrough(),
        keywords: z.array(
          z
            .object({
              trackingKeywordId: z.string(),
              keyword: z.string(),
              changed: z.boolean(),
              position: z
                .object({
                  previous: z.number().int().nullable(),
                  from: z.number().int().nullable(),
                  to: z.number().int().nullable(),
                  change: z.number().int().nullable(),
                  status: statusSchema,
                })
                .passthrough(),
              top10: z
                .object({
                  entered: z.array(changeSchema),
                  left: z.array(changeSchema),
                })
                .passthrough(),
              questions: addedRemovedSchema,
              aiOverview: z
                .object({
                  previous: aiOverviewStateSchema.nullable(),
                  from: aiOverviewStateSchema,
                  to: aiOverviewStateSchema,
                  status: statusSchema,
                })
                .passthrough(),
              featureTypes: addedRemovedSchema,
            })
            .passthrough(),
        ),
        totalCount: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        nextOffset: z.number().int().nonnegative().nullable(),
        domains: z.array(
          z
            .object({
              domain: z.string(),
              previous: z.number().int().nullable(),
              from: z.number().int(),
              to: z.number().int(),
              delta: z.number().int(),
              deltaSincePrevious: z.number().int().nullable(),
            })
            .passthrough(),
        ),
        notCompared: z.array(z.string()),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const { config, device, runs, keywords, notCompared, domains } =
      await SerpHistoryService.getChanges({
        projectId: args.projectId,
        projectDefaultDevice: context.project.defaultDevice,
        trackerId: args.trackerId,
        fromRunId: args.fromRunId,
        toRunId: args.toRunId,
        device: args.device,
      });
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 100;
    const listed =
      (args.onlyChanged ?? true)
        ? keywords.filter((keyword) => keyword.changed)
        : keywords;
    const page = listed.slice(offset, offset + limit);
    const nextOffset =
      offset + page.length < listed.length ? offset + page.length : null;
    const topDomains = domains.slice(0, MAX_DOMAINS);

    const lines = [
      `SERP changes for tracker ${config.id} (${config.domain}, ${device}): ${day(runs.from)} (${runs.from.id}) → ${day(runs.to)} (${runs.to.id}).`,
      runs.previous
        ? `"held" = changed by ${day(runs.from)} against ${day(runs.previous)} and still so on ${day(runs.to)}; the rest are single-check changes and may be noise.`
        : "No saved earlier check, so every change is a single-check change and may be noise.",
      `${keywords.filter((keyword) => keyword.changed).length} of ${keywords.length} keyword(s) changed. Keyword page: offset=${offset}, limit=${limit}, ${page.length} of ${listed.length} rows.${nextOffset !== null ? ` Next page: offset=${nextOffset}.` : ""}`,
    ];
    if (notCompared.length > 0) {
      lines.push(
        `Not compared (no saved SERP in both checks): ${notCompared.join(", ")}.`,
      );
    }
    if (topDomains.length > 0) {
      const previousRun = runs.previous;
      const columns: McpTableColumn<DomainRow>[] = [
        { header: "domain", value: (row) => row.domain },
        ...(previousRun
          ? [
              {
                header: day(previousRun),
                value: (row: DomainRow) => row.previous,
              },
            ]
          : []),
        { header: day(runs.from), value: (row) => row.from },
        { header: day(runs.to), value: (row) => row.to },
        { header: "delta", value: (row) => row.delta },
        ...(previousRun
          ? [
              {
                header: "since previous",
                value: (row: DomainRow) => row.deltaSincePrevious,
              },
            ]
          : []),
      ];
      lines.push(
        "",
        `Domains whose top-10 keyword count changed (${topDomains.length} of ${domains.length}):`,
        formatMcpTable(topDomains, columns),
      );
    }
    for (const keyword of page) {
      if (keyword.changed) lines.push("", ...keywordLines(keyword));
      else lines.push("", `## ${keyword.keyword}`, "No change.");
    }

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking/${config.id}`,
      ),
      structuredContent: {
        trackerId: config.id,
        domain: config.domain,
        device,
        runs,
        keywords: page,
        totalCount: listed.length,
        offset,
        limit,
        nextOffset,
        domains: topDomains,
        notCompared,
      },
    });
  }),
};
