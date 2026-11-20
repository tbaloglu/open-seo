import { z } from "zod";
import { isLabsLocationCode } from "@/shared/keyword-locations";

export const keywordGapInputSchema = z.object({
  projectId: z.string().min(1),
  competitorDomain: z.string().trim().min(1).max(255),
  // Competitor keywords come from Labs, as in the get_keyword_gap tool.
  locationCode: z
    .number()
    .int()
    .positive()
    .refine(isLabsLocationCode, "Pick a country DataForSEO Labs covers.")
    .optional(),
});

/** URL search params for /p/$projectId/keyword-gap. */
export const keywordGapSearchSchema = z.object({
  competitor: z.string().max(255).optional().catch(undefined),
  loc: z.coerce.number().int().positive().optional().catch(undefined),
});
