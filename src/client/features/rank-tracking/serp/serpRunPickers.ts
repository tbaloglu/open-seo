/**
 * The two checks "What changed" compares, from runs listed newest first. Only
 * saved checks can be picked; the later one must have a saved check before
 * it. A requested pick that no longer fits (the list refreshed, or the later
 * check moved past the earlier one) falls back to the nearest valid check.
 * Null when fewer than two checks were saved.
 */
export function resolveRunPair<Run extends { id: string; saved: boolean }>(
  runs: Run[],
  requested: { toId?: string; fromId?: string },
) {
  const lastSaved = runs.map((run) => run.saved).lastIndexOf(true);
  // Later candidates: every check before the oldest saved one.
  const laterOptions = runs.slice(0, Math.max(lastSaved, 0));
  const toRun =
    laterOptions.find((run) => run.saved && run.id === requested.toId) ??
    laterOptions.find((run) => run.saved);
  if (!toRun) return null;
  const earlierOptions = runs.slice(runs.indexOf(toRun) + 1);
  const fromRun =
    earlierOptions.find((run) => run.saved && run.id === requested.fromId) ??
    earlierOptions.find((run) => run.saved);
  if (!fromRun) return null;
  return { toId: toRun.id, fromId: fromRun.id, laterOptions, earlierOptions };
}
