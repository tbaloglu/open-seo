import type { ReactNode } from "react";
import { ExpandableList } from "@/client/components/ExpandableList";
import type { getSerpChanges } from "@/serverFunctions/serp-history";
import { HeldBadge } from "./serpParts";

type KeywordChange = Awaited<
  ReturnType<typeof getSerpChanges>
>["keywords"][number];
type SetChange = { value: string; persisted: boolean };

const showPosition = (value: number | null) => value ?? "—";

const none = <span className="text-muted-foreground">—</span>;

function Transition({
  values,
  held,
  tone,
}: {
  values: ReactNode[];
  held: boolean;
  tone: "up" | "down" | "neutral";
}) {
  const toneClass =
    tone === "up"
      ? "bg-success/20 text-success"
      : tone === "down"
        ? "bg-warning/20 text-warning"
        : "bg-muted text-foreground";
  const last = values.length - 1;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs whitespace-nowrap">
      {values.map((value, index) => (
        <span key={index} className="inline-flex items-center gap-1.5">
          {index > 0 && <span className="text-muted-foreground/60">→</span>}
          <span
            className={
              index === last
                ? `rounded px-1.5 py-0.5 font-semibold ${toneClass}`
                : "text-muted-foreground"
            }
          >
            {value}
          </span>
        </span>
      ))}
      {held && <HeldBadge />}
    </span>
  );
}

export function PositionChange({
  position,
}: {
  position: KeywordChange["position"];
}) {
  if (position.status === "unchanged") {
    return (
      <span className="font-mono text-xs text-muted-foreground">
        {showPosition(position.to)}
      </span>
    );
  }
  const held = position.status === "held";
  const values = held
    ? [position.previous, position.from, position.to]
    : [position.from, position.to];
  // A held change happened between previous and from; to equals from.
  const before = held ? position.previous : position.from;
  const tone =
    position.to === null
      ? "down"
      : before === null || position.to < before
        ? "up"
        : position.to > before
          ? "down"
          : "neutral";
  return (
    <span className="font-mono">
      <Transition values={values.map(showPosition)} held={held} tone={tone} />
    </span>
  );
}

const AI_LABELS = {
  cited: "Cited",
  not_cited: "Not cited",
  absent: "None",
} as const;

export function AiOverviewChange({
  aiOverview,
}: {
  aiOverview: KeywordChange["aiOverview"];
}) {
  if (aiOverview.status === "unchanged") {
    return (
      <span className="text-xs text-muted-foreground">
        {aiOverview.to === "absent" ? "—" : AI_LABELS[aiOverview.to]}
      </span>
    );
  }
  const held = aiOverview.status === "held";
  const values =
    held && aiOverview.previous
      ? [aiOverview.previous, aiOverview.from, aiOverview.to]
      : [aiOverview.from, aiOverview.to];
  return (
    <Transition
      values={values.map((value) => AI_LABELS[value])}
      held={held}
      tone={
        aiOverview.to === "cited"
          ? "up"
          : values.includes("cited")
            ? "down"
            : "neutral"
      }
    />
  );
}

export function SetChanges({
  added,
  removed,
  format = (value) => value,
}: {
  added: SetChange[];
  removed: SetChange[];
  format?: (value: string) => string;
}) {
  const items = [
    ...added.map((change) => ({ ...change, added: true })),
    ...removed.map((change) => ({ ...change, added: false })),
  ];
  if (items.length === 0) return none;
  return (
    <ExpandableList
      items={items}
      className="space-y-0.5 text-xs"
      renderItem={(item) => (
        <li
          key={`${item.added ? "+" : "-"}${item.value}`}
          className="flex items-start gap-1.5"
        >
          <span
            aria-label={item.added ? "Added" : "Removed"}
            className={`font-mono font-semibold ${item.added ? "text-success" : "text-warning"}`}
          >
            {item.added ? "+" : "−"}
          </span>
          <span className="break-words">{format(item.value)}</span>
          {item.persisted && <HeldBadge />}
        </li>
      )}
    />
  );
}
