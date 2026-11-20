import { addDays } from "@/server/features/search-archive/archivePlan";
import {
  SEO_TASK_MAX_TITLE_CHARS,
  type SeoTaskPriority,
} from "@/shared/seo-tasks";

// What every daily pulse rule shares: the windows, the change math and the
// alert's shape, title and evidence.

/** Days in the window being judged, and in the baseline before it. */
export const RECENT_DAYS = 7;
export const BASELINE_DAYS = 28;

/** Alerts kept per rule, the largest first, so a site-wide dip stays readable. */
export const MAX_ALERTS_PER_RULE = 10;

export const PULSE_ALERT_TYPES = [
  "traffic_drop",
  "page_disappeared",
  "rising_page",
  "organic_sessions_drop",
  "site_clicks_drop",
  "host_change",
] as const;
export type PulseAlertType = (typeof PULSE_ALERT_TYPES)[number];

/** The title prefix of each alert type; it also identifies the type on a task. */
export const TITLE_LABELS: Record<PulseAlertType, string> = {
  traffic_drop: "Trafik düşüşü",
  page_disappeared: "Gösterim kesildi",
  rising_page: "Gösterim artışı",
  organic_sessions_drop: "Organik oturum düşüşü",
  site_clicks_drop: "Site tıklama düşüşü",
  host_change: "Adres değişikliği",
};

const PRIORITIES: Record<PulseAlertType, SeoTaskPriority> = {
  traffic_drop: "high",
  page_disappeared: "high",
  rising_page: "medium",
  organic_sessions_drop: "high",
  site_clicks_drop: "high",
  host_change: "medium",
};

/**
 * The evidence starts with the alert type, so a task stays matched to its
 * alert even after its title is edited. Version 2 marks alerts from the rules
 * with full-coverage and www/apex folding; see DailyPulseService for why the
 * version matters.
 */
export const markerOf = (type: PulseAlertType) => `[nabız/2: ${type}]`;
/** The marker the first version of the rules wrote. */
export const legacyMarkerOf = (type: PulseAlertType) => `[nabız: ${type}]`;

export type DateWindow = { start: string; end: string };
export type Windows = { recent: DateWindow; baseline: DateWindow };

export type PulseAlert = {
  type: PulseAlertType;
  /** The page the alert is about; null for site-wide alerts. */
  url: string | null;
  title: string;
  priority: SeoTaskPriority;
  metric: "clicks" | "impressions" | "organic_sessions";
  recent: number;
  baseline: number;
  /** The baseline's daily average × 7: what the recent window would be at the same pace. */
  expected: number;
  /** Change of `recent` against `expected`, rounded; null when expected is 0. */
  changePercent: number | null;
  recentWindow: DateWindow;
  baselineWindow: DateWindow;
  evidence: string;
};

export function windowsEndingAt(end: string): Windows {
  const recentStart = addDays(end, 1 - RECENT_DAYS);
  const baselineEnd = addDays(recentStart, -1);
  return {
    recent: { start: recentStart, end },
    baseline: {
      start: addDays(baselineEnd, 1 - BASELINE_DAYS),
      end: baselineEnd,
    },
  };
}

/** Whether `recent` fell at least `percent` below the baseline's pace. */
export function fellBy(recent: number, baseline: number, percent: number) {
  // Integer math: recent × 28 × 100 ≤ baseline × 7 × (100 − percent).
  return (
    recent * BASELINE_DAYS * 100 <= baseline * RECENT_DAYS * (100 - percent)
  );
}

/** Whether `recent` rose at least `percent` above the baseline's pace. */
export function roseBy(recent: number, baseline: number, percent: number) {
  return (
    recent * BASELINE_DAYS * 100 >= baseline * RECENT_DAYS * (100 + percent)
  );
}

export const expectedFrom = (baseline: number) =>
  Math.round(((baseline * RECENT_DAYS) / BASELINE_DAYS) * 10) / 10;

function changePercent(recent: number, baseline: number): number | null {
  const expected = (baseline * RECENT_DAYS) / BASELINE_DAYS;
  return expected === 0
    ? null
    : Math.round(((recent - expected) / expected) * 100);
}

/**
 * The page's path (and query) for a short title, percent-decoded so Turkish
 * letters read as letters; the URL itself if unparsable.
 */
function pathOf(url: string): string {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}` || url;
  } catch {
    return url;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A URL's host-less address: lowercase host without "www.", path, query. */
export function canonicalKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** "<label>: <subject>", cut to the task title limit with the label kept. */
function alertTitle(type: PulseAlertType, subject: string): string {
  const title = `${TITLE_LABELS[type]}: ${subject}`;
  return title.length <= SEO_TASK_MAX_TITLE_CHARS
    ? title
    : `${title.slice(0, SEO_TASK_MAX_TITLE_CHARS - 1)}…`;
}

const METRIC_LABELS: Record<PulseAlert["metric"], string> = {
  clicks: "tıklama",
  impressions: "gösterim",
  organic_sessions: "organik oturum",
};

export function buildAlert(params: {
  type: PulseAlertType;
  url: string | null;
  /** The title after the label; defaults to the page's path or "site geneli". */
  subject?: string;
  /** Where the numbers come from, the evidence's first sentence. */
  source: string;
  metric: PulseAlert["metric"];
  recent: number;
  baseline: number;
  windows: Windows;
  /** Sentences appended to the evidence. */
  notes?: string[];
}): PulseAlert {
  const { type, url, metric, recent, baseline, windows } = params;
  const expected = expectedFrom(baseline);
  const change = changePercent(recent, baseline);
  const unit = METRIC_LABELS[metric];
  const evidence = [
    markerOf(type),
    `${params.source}.`,
    `Son ${RECENT_DAYS} gün (${windows.recent.start} – ${windows.recent.end}): ${recent} ${unit}.`,
    `Önceki ${BASELINE_DAYS} gün (${windows.baseline.start} – ${windows.baseline.end}): ${baseline} ${unit}; aynı tempoyla ${RECENT_DAYS} günde beklenen ${expected}.`,
    change === null ? null : `Değişim: ${change > 0 ? "+" : ""}${change}%.`,
    ...(params.notes ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    type,
    url,
    title: alertTitle(
      type,
      params.subject ?? (url ? pathOf(url) : "site geneli"),
    ),
    priority: PRIORITIES[type],
    metric,
    recent,
    baseline,
    expected,
    changePercent: change,
    recentWindow: windows.recent,
    baselineWindow: windows.baseline,
    evidence,
  };
}
