import type { ReactNode } from "react";
import { Badge } from "@/client/components/ui/badge";
import { parseDbTimestamp } from "@/client/lib/db-timestamp";

export type SerpTrackerProps = {
  projectId: string;
  configId: string;
  device: "desktop" | "mobile";
};

export const serpKey = (
  { projectId, configId, device }: SerpTrackerProps,
  ...rest: unknown[]
) => ["serpHistory", projectId, configId, device, ...rest];

export const runDate = (startedAt: string) =>
  // With the time, so two checks on one day can be told apart.
  parseDbTimestamp(startedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function OwnBadge() {
  return (
    <Badge variant="secondary" size="sm">
      You
    </Badge>
  );
}

/** Marks a change that two checks in a row showed. */
export function HeldBadge() {
  return (
    <Badge
      variant="outline"
      size="sm"
      className="cursor-help"
      title="Seen in the last two checks"
    >
      held
    </Badge>
  );
}

/** A short message in place of a tab's content. */
export function SerpMessage({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {children}
        </p>
      ) : null}
    </div>
  );
}

export const NOISE_NOTE =
  "Google varies between checks, so a change seen in one check may be noise.";
