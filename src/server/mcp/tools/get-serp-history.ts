import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { SerpHistoryService } from "@/server/features/serp-history/services/SerpHistoryService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "A keyword a rank tracker in this project tracks. Pass this or trackingKeywordId.",
    ),
  trackingKeywordId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Tracked keyword ID from get_rank_tracker. Picks the exact keyword, e.g. when a match-case tracker tracks both "Turşu" and "turşu".',
    ),
  trackerId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Rank tracker config ID from get_rank_tracker. Needed only when more than one tracker tracks the keyword.",
    ),
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe(
      "Device to read. Defaults to the tracker's only device, or the project's default device for a tracker that checks both.",
    ),
  runs: z
    .number()
    .int()
    .min(1)
    .max(26)
    .optional()
    .describe("How many of the latest completed checks to return. Default 6."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const featureValueSchema = z
  .object({ value: z.string().nullable(), domain: z.string().nullable() })
  .passthrough();

export const getSerpHistoryTool = {
  name: "get_serp_history",
  config: {
    title: "Get SERP history",
    description:
      "Read what Google showed for one tracked keyword at each of its latest rank checks, newest first: the tracked site's position, the top 10 organic results (rank, domain, url, title), and each SERP feature's content (People Also Ask questions, AI Overview sources with their domain, related searches, local pack businesses, compare sites, video sources). Rank checks save this from the page they already bought, so it uses no credits. Checks from before SERP history was saved, or whose page wasn't kept, show `saved: false`. One check is one read and Google varies between reads; trust a change that holds across checks. For what changed across all of a tracker's keywords, use get_serp_changes.",
    inputSchema,
    outputSchema: z
      .object({
        trackerId: z.string(),
        domain: z.string(),
        keyword: z.string(),
        trackingKeywordId: z.string(),
        device: z.enum(["desktop", "mobile"]),
        checks: z.array(
          z
            .object({
              runId: z.string(),
              checkedAt: z.string(),
              position: z.number().int().nullable(),
              saved: z.boolean(),
              top10: z.array(
                z
                  .object({
                    rank: z.number().int(),
                    domain: z.string().nullable(),
                    url: z.string().nullable(),
                    title: z.string().nullable(),
                  })
                  .passthrough(),
              ),
              features: z.array(
                z
                  .object({
                    type: z.string(),
                    values: z.array(featureValueSchema),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        ),
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
    if (!args.keyword && !args.trackingKeywordId) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Pass keyword or trackingKeywordId.",
      );
    }
    const { config, keyword, device, checks } =
      await SerpHistoryService.getKeywordHistory({
        projectId: args.projectId,
        projectDefaultDevice: context.project.defaultDevice,
        trackerId: args.trackerId,
        keyword: args.keyword,
        trackingKeywordId: args.trackingKeywordId,
        device: args.device,
        runs: args.runs ?? 6,
      });

    const lines = [
      `SERP history for "${keyword.keyword}" (${config.domain}, ${device}), latest ${checks.length} completed check(s), newest first.`,
    ];
    if (checks.length === 0) lines.push("No completed checks yet.");
    for (const check of checks) {
      lines.push(
        "",
        `## ${check.checkedAt.replace("T", " ").slice(0, 16)} — position ${check.position ?? "not found"}`,
      );
      if (!check.saved) {
        lines.push("SERP not saved for this check.");
        continue;
      }
      lines.push(
        `Top 10: ${check.top10.map((row) => `${row.rank}. ${row.domain ?? "(unknown)"}`).join(", ")}`,
      );
      for (const feature of check.features) {
        const values = feature.values.map((entry) =>
          entry.domain && !entry.value?.includes(entry.domain)
            ? `${entry.value} (${entry.domain})`
            : entry.value,
        );
        lines.push(
          `${feature.type}${values.length > 0 ? `: ${values.join("; ")}` : ""}`,
        );
      }
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
        keyword: keyword.keyword,
        trackingKeywordId: keyword.id,
        device,
        checks,
      },
    });
  }),
};
