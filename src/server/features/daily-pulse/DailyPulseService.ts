import { ga4DateInTimeZone } from "@/server/features/ga4/services/Ga4Dates";
import { SeoTaskRepository } from "@/server/features/seo-tasks/repositories/SeoTaskRepository";
import { SeoTaskService } from "@/server/features/seo-tasks/services/SeoTaskService";
import type { SeoTask } from "@/shared/seo-tasks";
import {
  compute,
  markerOf,
  PULSE_ALERT_TYPES,
  PULSE_TIME_ZONE,
  TITLE_LABELS,
  type PulseAlertType,
} from "./pulseAlerts";

// The daily pulse's tasks: after each successful archive run the alerts
// (pulseAlerts.ts) are written to the project's SEO tasks as proposals, one
// open task per alert and page.

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

/**
 * The alert type a pulse task was written for: from the marker that starts
 * its evidence, else (evidence edited away) from its title's label.
 */
function alertTypeOf(task: SeoTask): PulseAlertType | null {
  return (
    PULSE_ALERT_TYPES.find((type) =>
      task.evidence?.startsWith(markerOf(type)),
    ) ??
    PULSE_ALERT_TYPES.find((type) =>
      task.title.startsWith(`${TITLE_LABELS[type]}:`),
    ) ??
    null
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
    return { alerts: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
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
    errors: outcomes.filter((outcome) => outcome.action === "error").length,
  };
}

export const DailyPulseService = { compute, recordAlerts };
