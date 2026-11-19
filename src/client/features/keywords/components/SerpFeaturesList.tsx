import { Badge } from "@/client/components/ui/badge";
import type { SerpFeature } from "@/types/keywords";

const FEATURE_LABELS: Record<string, string> = {
  ai_overview: "AI Overview",
  people_also_ask: "People Also Ask",
  related_searches: "Related searches",
  people_also_search: "People also search",
  local_pack: "Local pack",
  video: "Videos",
  short_videos: "Short videos",
  compare_sites: "Places sites",
  featured_snippet: "Featured snippet",
  top_stories: "Top stories",
  images: "Images",
};

// Short values read better as chips; questions and sources as a list.
const CHIP_TYPES = new Set([
  "related_searches",
  "people_also_search",
  "compare_sites",
]);

function featureLabel(type: string) {
  const label = FEATURE_LABELS[type] ?? type.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The SERP features on the page and what each one shows. */
export function SerpFeaturesList({ features }: { features: SerpFeature[] }) {
  if (features.length === 0) return null;

  return (
    <section
      aria-label="SERP features"
      className="border-t border-border px-4 py-3 xl:max-h-64 xl:overflow-y-auto"
    >
      <h4 className="mb-2 text-xs font-semibold">SERP features</h4>
      <dl className="flex flex-col gap-3">
        {features.map((feature) => (
          <div key={feature.type} className="flex flex-col gap-1">
            <dt className="text-xs font-medium">
              {featureLabel(feature.type)}
            </dt>
            <dd className="text-xs text-muted-foreground">
              {feature.details.length === 0 ? (
                "On the page"
              ) : CHIP_TYPES.has(feature.type) ? (
                <div className="flex flex-wrap gap-1">
                  {feature.details.map((detail) => (
                    <Badge
                      key={detail}
                      variant="outline"
                      className="h-auto max-w-full font-normal whitespace-normal text-muted-foreground"
                    >
                      {detail}
                    </Badge>
                  ))}
                </div>
              ) : (
                <ul className="flex list-disc flex-col gap-0.5 pl-4">
                  {feature.details.map((detail) => (
                    <li key={detail} className="break-words">
                      {detail}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
