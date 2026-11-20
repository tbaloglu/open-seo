import { DataTableTabs } from "@/client/components/table/DataTableToolbar";
import { TabsTrigger } from "@/client/components/ui/tabs";
import { SerpChangesTab } from "./SerpChangesTab";
import { SerpCompetitorsTab } from "./SerpCompetitorsTab";
import { SerpQuestionsTab } from "./SerpQuestionsTab";
import type { SerpTrackerProps } from "./serpParts";

const TABS = [
  { value: "keywords", label: "Keywords" },
  { value: "competitors", label: "Competitors" },
  { value: "changes", label: "What changed" },
  { value: "questions", label: "Questions & sources" },
] as const;

type Tab = (typeof TABS)[number]["value"];
type SerpTabValue = Exclude<Tab, "keywords">;

/** The tab row under the tracker header, kept in the URL. */
export function RankTrackingTabs({
  tab,
  onTabChange,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  return (
    <div className="border-t border-border">
      <DataTableTabs
        value={tab}
        onValueChange={(value) => {
          const next = TABS.find((item) => item.value === value);
          if (next) onTabChange(next.value);
        }}
      >
        {TABS.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </DataTableTabs>
    </div>
  );
}

export function SerpTab({
  tab,
  ...props
}: SerpTrackerProps & { tab: SerpTabValue }) {
  if (tab === "competitors") return <SerpCompetitorsTab {...props} />;
  if (tab === "changes") return <SerpChangesTab {...props} />;
  return <SerpQuestionsTab {...props} />;
}
