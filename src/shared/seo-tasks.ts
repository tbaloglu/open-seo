// SEO tasks ("Yapılacaklar"): option sets shared by the app, the server
// functions and the MCP tools, so the three stay in sync.

export const SEO_TASK_STATUSES = [
  "proposed",
  "selected",
  "in_progress",
  "done",
  "dropped",
] as const;
export const SEO_TASK_PRIORITIES = ["high", "medium", "low"] as const;
export const SEO_TASK_SIZES = ["S", "M", "L"] as const;

export type SeoTaskStatus = (typeof SEO_TASK_STATUSES)[number];
export type SeoTaskPriority = (typeof SEO_TASK_PRIORITIES)[number];
export type SeoTaskSize = (typeof SEO_TASK_SIZES)[number];

export const SEO_TASK_STATUS_LABELS: Record<SeoTaskStatus, string> = {
  proposed: "Proposed",
  selected: "Selected",
  in_progress: "In progress",
  done: "Done",
  dropped: "Dropped",
};

export const SEO_TASK_PRIORITY_LABELS: Record<SeoTaskPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const SEO_TASK_MAX_TITLE_CHARS = 300;
export const SEO_TASK_MAX_TEXT_CHARS = 10_000;
export const SEO_TASK_MAX_CODE_CHARS = 32;
export const SEO_TASK_MAX_URLS = 50;
export const SEO_TASK_MAX_SAVE_BATCH = 100;
// A runaway guard; a project's list is tens of tasks, not thousands.
export const SEO_TASK_MAX_PER_PROJECT = 2_000;
export const SEO_TASK_DEFAULT_LIST_LIMIT = 100;
export const SEO_TASK_MAX_LIST_LIMIT = 500;

export type SeoTask = {
  id: string;
  code: string | null;
  title: string;
  description: string | null;
  evidence: string | null;
  expectedImpact: string | null;
  size: SeoTaskSize | null;
  priority: SeoTaskPriority;
  status: SeoTaskStatus;
  sourceReportId: string | null;
  createdAt: string;
  statusChangedAt: string;
  doneAt: string | null;
  outcomeNote: string | null;
  affectedUrls: string[];
};
