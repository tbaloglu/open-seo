import { and, asc, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  ga4Connections,
  gscConnections,
  projects,
  searchArchiveRuns,
} from "@/db/schema";

// Which projects the daily archive starts (scheduledSearchArchive.ts). Read by
// the cron across all projects; each start is then scoped to its project.

/**
 * Projects the daily archive may start: not archived (soft-deleted) projects
 * with Search Console or Analytics connected, whose latest run completed
 * before `completedBefore`, failed before `failedBefore`, is still marked
 * running since before `runningBefore`, or does not exist. Never-run projects
 * first, then the longest waiting. Each comes with its latest run's mode and
 * status (null when it never ran).
 */
async function listScheduleCandidates(params: {
  completedBefore: string;
  failedBefore: string;
  runningBefore: string;
  limit: number;
}) {
  const finished = sql`coalesce(${searchArchiveRuns.finishedAt}, ${searchArchiveRuns.startedAt})`;
  const rows = await db
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
              .where(eq(gscConnections.projectId, projects.id)),
          ),
          exists(
            db
              .select({ id: ga4Connections.id })
              .from(ga4Connections)
              .where(eq(ga4Connections.projectId, projects.id)),
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
          and(
            eq(searchArchiveRuns.status, "running"),
            lt(searchArchiveRuns.startedAt, params.runningBefore),
          ),
        ),
      ),
    )
    .orderBy(sql`coalesce(${finished}, '')`, asc(projects.id))
    .limit(params.limit);
  return rows;
}

export const SearchArchiveScheduleRepository = { listScheduleCandidates };
