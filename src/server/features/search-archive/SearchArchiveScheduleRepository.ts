import {
  and,
  asc,
  count,
  eq,
  exists,
  gte,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  ga4Connections,
  gscConnections,
  projects,
  searchArchiveRuns,
} from "@/db/schema";
import { connectorIsMember } from "@/server/features/google/connectorIsMember";

// Which projects the daily archive starts (scheduledSearchArchive.ts). Read by
// the cron across all projects; each start is then scoped to its project.

/**
 * Projects the daily archive may start: not archived (soft-deleted) projects
 * with Search Console or Analytics connected by someone still in the
 * organization (the same rule the connection repositories read by), whose
 * latest run completed before `completedBefore`, failed before
 * `failedBefore`, or does not exist. Never-run projects first, then the
 * longest waiting. Each comes with its latest run's mode and status (null
 * when it never ran). Runs still marked running are not candidates; see
 * listStaleRunning.
 */
async function listScheduleCandidates(params: {
  completedBefore: string;
  failedBefore: string;
  limit: number;
}) {
  const finished = sql`coalesce(${searchArchiveRuns.finishedAt}, ${searchArchiveRuns.startedAt})`;
  const [gscMember, ga4Member] = await Promise.all([
    connectorIsMember(gscConnections),
    connectorIsMember(ga4Connections),
  ]);
  return db
    .select({
      projectId: projects.id,
      lastMode: searchArchiveRuns.mode,
      lastStatus: searchArchiveRuns.status,
    })
    .from(projects)
    .leftJoin(searchArchiveRuns, eq(searchArchiveRuns.projectId, projects.id))
    .where(
      and(
        isNull(projects.archivedAt),
        or(
          exists(
            db
              .select({ id: gscConnections.id })
              .from(gscConnections)
              .where(and(eq(gscConnections.projectId, projects.id), gscMember)),
          ),
          exists(
            db
              .select({ id: ga4Connections.id })
              .from(ga4Connections)
              .where(and(eq(ga4Connections.projectId, projects.id), ga4Member)),
          ),
        ),
        or(
          isNull(searchArchiveRuns.projectId),
          and(
            eq(searchArchiveRuns.status, "completed"),
            lt(finished, params.completedBefore),
          ),
          and(
            eq(searchArchiveRuns.status, "failed"),
            lt(finished, params.failedBefore),
          ),
        ),
      ),
    )
    .orderBy(sql`coalesce(${finished}, '')`, asc(projects.id))
    .limit(params.limit);
}

/** Runs marked running that started at or after `since`, per mode. */
async function countRunning(since: string) {
  const rows = await db
    .select({ mode: searchArchiveRuns.mode, total: count() })
    .from(searchArchiveRuns)
    .where(
      and(
        eq(searchArchiveRuns.status, "running"),
        gte(searchArchiveRuns.startedAt, since),
      ),
    )
    .groupBy(searchArchiveRuns.mode);
  const byMode = Object.fromEntries(rows.map((row) => [row.mode, row.total]));
  return {
    backfill: byMode.backfill ?? 0,
    incremental: byMode.incremental ?? 0,
  };
}

/** Projects whose run has been marked running since before `before`, oldest first. */
async function listStaleRunning(before: string, limit: number) {
  const rows = await db
    .select({ projectId: searchArchiveRuns.projectId })
    .from(searchArchiveRuns)
    .where(
      and(
        eq(searchArchiveRuns.status, "running"),
        lt(searchArchiveRuns.startedAt, before),
      ),
    )
    .orderBy(asc(searchArchiveRuns.startedAt))
    .limit(limit);
  return rows.map((row) => row.projectId);
}

export const SearchArchiveScheduleRepository = {
  listScheduleCandidates,
  countRunning,
  listStaleRunning,
};
