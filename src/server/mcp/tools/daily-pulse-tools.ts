import { z } from "zod";
import {
  DailyPulseService,
  PULSE_ALERT_TYPES,
} from "@/server/features/daily-pulse/DailyPulseService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

// The daily pulse, read-only: alerts computed from the project's own search
// archive. The project is authorized first; every archive read is keyed by it.

const inputSchema = {
  projectId: projectIdSchema,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
      message: "Not a real date.",
    })
    .optional()
    .describe(
      "Last day (YYYY-MM-DD) of the 7-day window. Defaults to the latest complete day in the archive: 3 days ago (Pacific Time) for Search Console, 2 days ago for Analytics.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const windowSchema = z.looseObject({ start: z.string(), end: z.string() });
const sourceSchema = z.looseObject({
  evaluated: z.boolean(),
  reason: z.string().optional(),
  recent: windowSchema.optional(),
  baseline: windowSchema.optional(),
});

type SourceStatus = Awaited<
  ReturnType<typeof DailyPulseService.compute>
>["gsc"];

function sourceLine(label: string, source: SourceStatus): string {
  return source.evaluated
    ? `${label}: ${source.recent.start} – ${source.recent.end} vs ${source.baseline.start} – ${source.baseline.end}.`
    : `${label}: skipped. ${source.reason}`;
}

export const getDailyPulseTool = {
  name: "get_daily_pulse",
  config: {
    title: "Get daily pulse",
    description:
      "Compute the project's daily pulse alerts from OpenSEO's own Search Console and Analytics archive (no Google calls, no credits). Compares the last 7 complete days with the 28 days before them, scaled to 7 days: traffic_drop (a page's clicks fell 50% or more, with at least 20 baseline clicks), page_disappeared (a page with at least 50 baseline impressions got none), rising_page (a page's impressions rose 100% or more to at least 100) and organic_sessions_drop (GA4 organic sessions fell 40% or more, with at least 50 baseline sessions). Each alert has the exact numbers and date ranges. Read-only: after each archive run the same alerts are written to the SEO tasks as proposals with codes N-YYYYMMDD-n (see list_seo_tasks). A source is skipped, with the reason, when the archive does not cover the whole 35 days; run archive_search_data first.",
    inputSchema,
    outputSchema: z.looseObject({
      gsc: sourceSchema,
      ga4: sourceSchema,
      alerts: z.array(
        z.looseObject({
          type: z.enum(PULSE_ALERT_TYPES),
          url: z.string().nullable(),
          title: z.string(),
          recent: z.number(),
          baseline: z.number(),
          expected: z.number(),
          changePercent: z.number().nullable(),
          evidence: z.string(),
        }),
      ),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const pulse = await DailyPulseService.compute(args.projectId, {
      date: args.date,
    });
    const alerts =
      pulse.alerts.length > 0
        ? pulse.alerts
            .map(
              (alert) =>
                `- [${alert.type}] ${alert.title}\n  ${alert.evidence}`,
            )
            .join("\n")
        : "No alerts.";
    return mcpResponse({
      text: `${sourceLine("Search Console", pulse.gsc)}\n${sourceLine("Google Analytics", pulse.ga4)}\n${alerts}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/tasks`,
      ),
      structuredContent: pulse,
    });
  }),
};
