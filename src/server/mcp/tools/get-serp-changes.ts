import { z } from "zod";
import { SerpHistoryService } from "@/server/features/serp-history/services/SerpHistoryService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable } from "@/server/mcp/table";
import { projectIdSchema } from "@/server/mcp/schemas";

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
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const changeSchema = z
  .object({ value: z.string(), persisted: z.boolean() })
  .passthrough();
const addedRemovedSchema = z
  .object({ added: z.array(changeSchema), removed: z.array(changeSchema) })
  .passthrough();
const aiOverviewStateSchema = z.enum(["cited", "not_cited", "absent"]);
const runSchema = z
  .object({ id: z.string(), startedAt: z.string() })
  .passthrough();

type Change = z.infer<typeof changeSchema>;

const day = (run: { startedAt: string }) => run.startedAt.slice(0, 10);

/** "a.com, b.com (held)" — held marks a change that persisted two checks. */
function listChanges(changes: Change[]) {
  return changes
    .map((change) => `${change.value}${change.persisted ? " (held)" : ""}`)
    .join(", ");
}

export const getSerpChangesTool = {
  name: "get_serp_changes",
  config: {
    title: "Get SERP changes",
    description:
      "Compare what Google showed for every keyword of a rank tracker between two completed checks, by default the latest two. Per keyword: the tracked site's position at each check, domains that entered or left the top 10, People Also Ask questions added or removed, whether the site is an AI Overview source (cited / not_cited / absent), and SERP feature types added or removed. Also a summary of domains whose top-10 count changed across keywords, which shows who is gaining or losing. One check is one read and Google varies between reads, so a change seen only in the latest check has `persisted: false` and may be noise; when an earlier check exists, a change from the check before `from` that the latest check still shows is listed with `persisted: true`. Lead with those. Uses no credits. Only checks saved since SERP history began can be compared; keywords without a saved SERP in both checks are listed in `notCompared`.",
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
                })
                .passthrough(),
              featureTypes: addedRemovedSchema,
            })
            .passthrough(),
        ),
        domains: z.array(
          z
            .object({
              domain: z.string(),
              previous: z.number().int(),
              from: z.number().int(),
              to: z.number().int(),
              delta: z.number().int(),
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

    const changed = keywords.filter((keyword) => keyword.changed);
    const lines = [
      `SERP changes for tracker ${config.id} (${config.domain}, ${device}): ${day(runs.from)} (${runs.from.id}) → ${day(runs.to)} (${runs.to.id}).`,
      runs.previous
        ? `"held" = changed by ${day(runs.from)} against ${day(runs.previous)} and still so on ${day(runs.to)}; the rest are single-check changes and may be noise.`
        : "No earlier check, so every change is a single-check change and may be noise.",
      `${changed.length} of ${keywords.length} keyword(s) changed.`,
    ];
    if (notCompared.length > 0) {
      lines.push(
        `Not compared (no saved SERP in both checks): ${notCompared.join(", ")}.`,
      );
    }
    if (domains.length > 0) {
      lines.push(
        "",
        "Domains by top-10 count:",
        formatMcpTable(domains.slice(0, 30), [
          { header: "domain", value: (row) => row.domain },
          ...(runs.previous
            ? [
                {
                  header: day(runs.previous),
                  value: (row: (typeof domains)[number]) => row.previous,
                },
              ]
            : []),
          { header: day(runs.from), value: (row) => row.from },
          { header: day(runs.to), value: (row) => row.to },
          { header: "delta", value: (row) => row.delta },
        ]),
      );
    }
    for (const keyword of changed) {
      const { position, top10, questions, aiOverview, featureTypes } = keyword;
      lines.push(
        "",
        `## ${keyword.keyword}`,
        `Position: ${[position.previous, position.from, position.to]
          .slice(runs.previous ? 0 : 1)
          .map((value) => value ?? "—")
          .join(" → ")}`,
      );
      if (top10.entered.length > 0)
        lines.push(`Entered top 10: ${listChanges(top10.entered)}`);
      if (top10.left.length > 0)
        lines.push(`Left top 10: ${listChanges(top10.left)}`);
      if (questions.added.length > 0)
        lines.push(`New questions: ${listChanges(questions.added)}`);
      if (questions.removed.length > 0)
        lines.push(`Removed questions: ${listChanges(questions.removed)}`);
      if (aiOverview.from !== aiOverview.to)
        lines.push(`AI Overview: ${aiOverview.from} → ${aiOverview.to}`);
      if (featureTypes.added.length > 0)
        lines.push(`New features: ${listChanges(featureTypes.added)}`);
      if (featureTypes.removed.length > 0)
        lines.push(`Removed features: ${listChanges(featureTypes.removed)}`);
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
        runs: { ...runs, previous: runs.previous ?? null },
        keywords,
        domains,
        notCompared,
      },
    });
  }),
};
