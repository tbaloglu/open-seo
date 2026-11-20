import { sortBy } from "remeda";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { ga4DateInTimeZone } from "@/server/features/ga4/services/Ga4Dates";
import {
  addDays,
  GSC_TIME_ZONE,
} from "@/server/features/search-archive/archivePlan";
import { SeoTaskRepository } from "@/server/features/seo-tasks/repositories/SeoTaskRepository";
import { SeoTaskService } from "@/server/features/seo-tasks/services/SeoTaskService";
import type { SeoTask, SeoTaskPriority } from "@/shared/seo-tasks";
import { DailyPulseRepository } from "./DailyPulseRepository";

// The daily pulse: alerts computed from the project's own search archive (no
// Google calls), compared over the last 7 complete days against the 28 days
// before them. After each successful archive run the alerts are written to
// the project's SEO tasks as proposals, one open task per alert and page.

/** Days in the window being judged, and in the baseline before it. */
const RECENT_DAYS = 7;
const BASELINE_DAYS = 28;

/** (a) A page's clicks fell at least this much against the baseline pace. */
const TRAFFIC_DROP_PERCENT = 50;
/** (a) Pages with fewer baseline clicks are too noisy to judge. */
const TRAFFIC_DROP_MIN_BASELINE_CLICKS = 20;
/** (b) A page with this many baseline impressions and none recently. */
const DISAPPEARED_MIN_BASELINE_IMPRESSIONS = 50;
/** (c) A page's impressions rose at least this much against the baseline pace. */
const RISING_PERCENT = 100;
/** (c) ...and reached at least this many impressions in the recent window. */
const RISING_MIN_RECENT_IMPRESSIONS = 100;
/** (d) GA4 organic sessions fell at least this much against the baseline pace. */
const ORGANIC_DROP_PERCENT = 40;
/** (d) Sites with fewer baseline organic sessions are too noisy to judge. */
const ORGANIC_DROP_MIN_BASELINE_SESSIONS = 50;

/** Alerts kept per rule, the largest first, so a site-wide dip stays readable. */
const MAX_ALERTS_PER_RULE = 10;

/**
 * Search Console revises its latest days (the archive reads them with
 * dataState "all"), so the recent window ends this many days before today in
 * Pacific Time.
 */
const GSC_COMPLETE_LAG_DAYS = 3;
/** GA4 can take up to two days to finish processing a day. */
const GA4_COMPLETE_LAG_DAYS = 2;

/** Alert codes are dated in the owner's time zone: N-YYYYMMDD-<n>. */
const PULSE_TIME_ZONE = "Europe/Istanbul";
const CODE_PREFIX = "N-";

/**
 * A closed (done or dropped) alert task holds back the same alert this long,
 * so a page the owner removed on purpose is not proposed again every day.
 */
const CLOSED_ALERT_QUIET_DAYS = 28;

const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "proposed",
  "selected",
  "in_progress",
]);

export const PULSE_ALERT_TYPES = [
  "traffic_drop",
  "page_disappeared",
  "rising_page",
  "organic_sessions_drop",
] as const;
type PulseAlertType = (typeof PULSE_ALERT_TYPES)[number];

/** The title prefix of each alert type; it also identifies the type on a task. */
const TITLE_LABELS: Record<PulseAlertType, string> = {
  traffic_drop: "Trafik düşüşü",
  page_disappeared: "Gösterim kesildi",
  rising_page: "Gösterim artışı",
  organic_sessions_drop: "Organik oturum düşüşü",
};

const DESCRIPTIONS: Record<PulseAlertType, string> = {
  traffic_drop:
    "Sayfanın Search Console tıklamaları son 7 günde, önceki 28 günün temposuna göre belirgin düştü. Sıra kaybı, başlık ya da içerik değişikliği, rakip ya da mevsim etkisi olabilir; sayfanın aramalarına bakın.",
  page_disappeared:
    "Önceki 28 günde gösterim alan sayfa son 7 günde hiç gösterim almadı. Dizinden çıkmış olabilir (noindex, yönlendirme, 404, canonical); URL Denetimi ile kontrol edin.",
  rising_page:
    "Sayfanın gösterimleri son 7 günde, önceki 28 günün temposuna göre hızla arttı. Yükselen aramaları görmek ve sayfayı onlara göre güçlendirmek için bir fırsat.",
  organic_sessions_drop:
    "Sitenin Google Analytics organik oturumları son 7 günde, önceki 28 günün temposuna göre sert düştü. Search Console tıklamalarıyla karşılaştırın; ölçüm (etiket) sorunu da olabilir.",
};

type DateWindow = { start: string; end: string };
type Windows = { recent: DateWindow; baseline: DateWindow };

type PulseAlert = {
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

type SourceStatus =
  | ({ evaluated: true } & Windows)
  | { evaluated: false; reason: string };

type DailyPulse = {
  gsc: SourceStatus;
  ga4: SourceStatus;
  alerts: PulseAlert[];
};

function windowsEndingAt(end: string): Windows {
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
function fellBy(recent: number, baseline: number, percent: number) {
  // Integer math: recent × 28 × 100 ≤ baseline × 7 × (100 − percent).
  return (
    recent * BASELINE_DAYS * 100 <= baseline * RECENT_DAYS * (100 - percent)
  );
}

/** Whether `recent` rose at least `percent` above the baseline's pace. */
function roseBy(recent: number, baseline: number, percent: number) {
  return (
    recent * BASELINE_DAYS * 100 >= baseline * RECENT_DAYS * (100 + percent)
  );
}

const expectedFrom = (baseline: number) =>
  Math.round(((baseline * RECENT_DAYS) / BASELINE_DAYS) * 10) / 10;

function changePercent(recent: number, baseline: number): number | null {
  const expected = (baseline * RECENT_DAYS) / BASELINE_DAYS;
  return expected === 0
    ? null
    : Math.round(((recent - expected) / expected) * 100);
}

/** The path of a page URL, for a short title; the URL itself if unparsable. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url;
  }
}

const METRIC_LABELS: Record<PulseAlert["metric"], string> = {
  clicks: "tıklama",
  impressions: "gösterim",
  organic_sessions: "organik oturum",
};

function buildAlert(params: {
  type: PulseAlertType;
  url: string | null;
  metric: PulseAlert["metric"];
  recent: number;
  baseline: number;
  windows: Windows;
}): PulseAlert {
  const { type, url, metric, recent, baseline, windows } = params;
  const expected = expectedFrom(baseline);
  const change = changePercent(recent, baseline);
  const unit = METRIC_LABELS[metric];
  const source =
    metric === "organic_sessions"
      ? "Google Analytics, site geneli (OpenSEO arşivi, ga4_daily_site)"
      : `Search Console, sayfa ${url} (OpenSEO arşivi, gsc_daily_page)`;
  const evidence = [
    `${source}.`,
    `Son ${RECENT_DAYS} gün (${windows.recent.start} – ${windows.recent.end}): ${recent} ${unit}.`,
    `Önceki ${BASELINE_DAYS} gün (${windows.baseline.start} – ${windows.baseline.end}): ${baseline} ${unit}; aynı tempoyla ${RECENT_DAYS} günde beklenen ${expected}.`,
    change === null ? null : `Değişim: ${change > 0 ? "+" : ""}${change}%.`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    type,
    url,
    title: `${TITLE_LABELS[type]}: ${url ? pathOf(url) : "site geneli"}`,
    priority: type === "rising_page" ? "medium" : "high",
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

/**
 * Picks the window's end: the requested day, or the latest complete day the
 * archive holds. The archive must cover the whole baseline and recent window,
 * or a missing day would read as a drop.
 */
function resolveWindows(params: {
  requested: string | undefined;
  latestComplete: string;
  dates: { first: string | null; last: string | null };
  label: string;
}): SourceStatus {
  const { dates, label } = params;
  if (!dates.first || !dates.last) {
    return { evaluated: false, reason: `The archive has no ${label} data.` };
  }
  const end =
    params.requested ??
    (dates.last < params.latestComplete ? dates.last : params.latestComplete);
  const windows = windowsEndingAt(end);
  if (dates.last < end) {
    return {
      evaluated: false,
      reason: `The ${label} archive ends on ${dates.last}, before ${end}. Run the archive first.`,
    };
  }
  if (dates.first > windows.baseline.start) {
    return {
      evaluated: false,
      reason: `The ${label} archive starts on ${dates.first}; the comparison needs data from ${windows.baseline.start}.`,
    };
  }
  return { evaluated: true, ...windows };
}

async function pageAlerts(projectId: string, windows: Windows) {
  const rows = await DailyPulseRepository.pageTotals(projectId, {
    baselineStart: windows.baseline.start,
    baselineEnd: windows.baseline.end,
    recentStart: windows.recent.start,
    recentEnd: windows.recent.end,
  });
  const disappeared = rows.filter(
    (row) =>
      row.recentImpressions === 0 &&
      row.baselineImpressions >= DISAPPEARED_MIN_BASELINE_IMPRESSIONS,
  );
  const disappearedPages = new Set(disappeared.map((row) => row.page));
  // A page that disappeared is reported as that, not also as a drop.
  const dropped = rows.filter(
    (row) =>
      !disappearedPages.has(row.page) &&
      row.baselineClicks >= TRAFFIC_DROP_MIN_BASELINE_CLICKS &&
      fellBy(row.recentClicks, row.baselineClicks, TRAFFIC_DROP_PERCENT),
  );
  const rising = rows.filter(
    (row) =>
      row.recentImpressions >= RISING_MIN_RECENT_IMPRESSIONS &&
      roseBy(row.recentImpressions, row.baselineImpressions, RISING_PERCENT),
  );
  return [
    ...sortBy(dropped, [
      (row) => expectedFrom(row.baselineClicks) - row.recentClicks,
      "desc",
    ])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((row) =>
        buildAlert({
          type: "traffic_drop",
          url: row.page,
          metric: "clicks",
          recent: row.recentClicks,
          baseline: row.baselineClicks,
          windows,
        }),
      ),
    ...sortBy(disappeared, [(row) => row.baselineImpressions, "desc"])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((row) =>
        buildAlert({
          type: "page_disappeared",
          url: row.page,
          metric: "impressions",
          recent: 0,
          baseline: row.baselineImpressions,
          windows,
        }),
      ),
    ...sortBy(rising, [
      (row) => row.recentImpressions - expectedFrom(row.baselineImpressions),
      "desc",
    ])
      .slice(0, MAX_ALERTS_PER_RULE)
      .map((row) =>
        buildAlert({
          type: "rising_page",
          url: row.page,
          metric: "impressions",
          recent: row.recentImpressions,
          baseline: row.baselineImpressions,
          windows,
        }),
      ),
  ];
}

async function organicAlerts(projectId: string, windows: Windows) {
  const totals = await DailyPulseRepository.organicSessionTotals(projectId, {
    baselineStart: windows.baseline.start,
    baselineEnd: windows.baseline.end,
    recentStart: windows.recent.start,
    recentEnd: windows.recent.end,
  });
  if (
    totals.baseline < ORGANIC_DROP_MIN_BASELINE_SESSIONS ||
    !fellBy(totals.recent, totals.baseline, ORGANIC_DROP_PERCENT)
  ) {
    return [];
  }
  return [
    buildAlert({
      type: "organic_sessions_drop",
      url: null,
      metric: "organic_sessions",
      recent: totals.recent,
      baseline: totals.baseline,
      windows,
    }),
  ];
}

/**
 * The alerts for a project. `date` is the last day of the 7-day window; by
 * default it is the latest complete day the archive holds, per source.
 * Read-only.
 */
async function compute(
  projectId: string,
  options: { date?: string; now?: Date } = {},
): Promise<DailyPulse> {
  const now = options.now ?? new Date();
  const [gscDates, ga4Dates, ga4] = await Promise.all([
    DailyPulseRepository.archivedDays(projectId, "gsc_page"),
    DailyPulseRepository.archivedDays(projectId, "ga4_site"),
    Ga4ConnectionRepository.getByProjectId(projectId),
  ]);
  const gsc = resolveWindows({
    requested: options.date,
    latestComplete: addDays(
      ga4DateInTimeZone(now, GSC_TIME_ZONE),
      -GSC_COMPLETE_LAG_DAYS,
    ),
    dates: gscDates,
    label: "Search Console page",
  });
  const ga4Status = resolveWindows({
    requested: options.date,
    latestComplete: addDays(
      ga4DateInTimeZone(now, ga4?.propertyTimeZone ?? PULSE_TIME_ZONE),
      -GA4_COMPLETE_LAG_DAYS,
    ),
    dates: ga4Dates,
    label: "Google Analytics",
  });
  const alerts = [
    ...(gsc.evaluated ? await pageAlerts(projectId, gsc) : []),
    ...(ga4Status.evaluated ? await organicAlerts(projectId, ga4Status) : []),
  ];
  return { gsc, ga4: ga4Status, alerts };
}

/** The alert type a pulse task was written for, read from its title. */
function alertTypeOf(task: SeoTask): PulseAlertType | null {
  return (
    PULSE_ALERT_TYPES.find((type) =>
      task.title.startsWith(`${TITLE_LABELS[type]}:`),
    ) ?? null
  );
}

const alertKey = (type: PulseAlertType, url: string | null) =>
  `${type} ${url ?? ""}`;

/**
 * Computes today's alerts and writes them to the project's SEO tasks. An
 * alert whose open task (proposed, selected or in progress) exists only
 * refreshes that task's evidence; one closed within CLOSED_ALERT_QUIET_DAYS is
 * skipped; otherwise a proposed task is created with code N-YYYYMMDD-<n>.
 * Running it again the same day changes nothing but the evidence.
 */
async function recordAlerts(projectId: string, now: Date = new Date()) {
  const pulse = await compute(projectId, { now });
  if (pulse.alerts.length === 0) {
    return { alerts: 0, created: 0, updated: 0, skipped: 0 };
  }
  const existing = await SeoTaskRepository.listByCodePrefix(
    projectId,
    CODE_PREFIX,
  );
  const quietSince = new Date(
    now.getTime() - CLOSED_ALERT_QUIET_DAYS * 24 * 60 * 60_000,
  ).toISOString();
  const open = new Map<string, SeoTask>();
  const quiet = new Set<string>();
  for (const task of existing) {
    const type = alertTypeOf(task);
    if (!type) continue;
    const key = alertKey(type, task.affectedUrls[0] ?? null);
    if (OPEN_STATUSES.has(task.status)) open.set(key, task);
    else if (task.statusChangedAt >= quietSince) quiet.add(key);
  }

  const day = ga4DateInTimeZone(now, PULSE_TIME_ZONE).replaceAll("-", "");
  const dayPrefix = `${CODE_PREFIX}${day}-`;
  let next =
    Math.max(
      0,
      ...existing
        .map((task) => task.code ?? "")
        .filter((code) => code.startsWith(dayPrefix))
        .map((code) => Number(code.slice(dayPrefix.length)) || 0),
    ) + 1;

  let skipped = 0;
  const writes: Parameters<typeof SeoTaskService.save>[0]["tasks"] = [];
  for (const alert of pulse.alerts) {
    const key = alertKey(alert.type, alert.url);
    const task = open.get(key);
    if (task) {
      writes.push({ id: task.id, evidence: alert.evidence });
    } else if (quiet.has(key)) {
      skipped++;
    } else {
      writes.push({
        code: `${dayPrefix}${next++}`,
        title: alert.title,
        description: DESCRIPTIONS[alert.type],
        evidence: alert.evidence,
        affectedUrls: alert.url ? [alert.url] : [],
        priority: alert.priority,
        size: "S",
        status: "proposed",
      });
    }
  }
  const outcomes =
    writes.length > 0
      ? await SeoTaskService.save({ projectId, tasks: writes })
      : [];
  for (const outcome of outcomes) {
    if (outcome.action === "error") {
      console.error(
        `[daily-pulse] project ${projectId}: could not save alert: ${outcome.message}`,
      );
    }
  }
  return {
    alerts: pulse.alerts.length,
    created: outcomes.filter((outcome) => outcome.action === "created").length,
    updated: outcomes.filter((outcome) => outcome.action === "updated").length,
    skipped,
  };
}

export const DailyPulseService = { compute, recordAlerts };
