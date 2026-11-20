import { z } from "zod";

export const keywordGapInputSchema = z.object({
  projectId: z.string().min(1),
  competitorDomain: z.string().trim().min(1).max(255),
  locationCode: z.number().int().positive().optional(),
});

/** URL search params for /p/$projectId/keyword-gap. */
export const keywordGapSearchSchema = z.object({
  competitor: z.string().max(255).optional().catch(undefined),
  loc: z.coerce.number().int().positive().optional().catch(undefined),
});
