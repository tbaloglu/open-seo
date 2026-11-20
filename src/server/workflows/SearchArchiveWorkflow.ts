import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { ArchiveJobPayload } from "@/server/features/search-archive/SearchArchiveService";
import { runSearchArchive } from "./searchArchiveRun";
import { yieldingStep } from "./yieldingStep";

/**
 * Copies a project's Search Console and Google Analytics history into the
 * archive tables. Started by SearchArchiveService.start for a project the
 * caller was authorized for; the payload's project is trusted from there.
 */
export class SearchArchiveWorkflow extends WorkflowEntrypoint<
  Env,
  ArchiveJobPayload
> {
  async run(event: WorkflowEvent<ArchiveJobPayload>, engineStep: WorkflowStep) {
    await runSearchArchive(event.payload, yieldingStep(engineStep));
  }
}
