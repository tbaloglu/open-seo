import { z } from "zod";
import { unwrapGoogleRedirect } from "@/server/lib/dataforseo/serp";

// A feature row's content lives in DataForSEO's nested elements, whose shapes
// vary by type: plain strings for searches, objects for the rest. Anything
// unexpected yields no details rather than failing the row.
const MAX_FEATURE_DETAILS = 10;
const featureElementSchema = z.union([
  z.string(),
  z.looseObject({
    title: z.string().nullish(),
    domain: z.string().nullish(),
    url: z.string().nullish(),
    // The site's name as Google shows it ("Instagram", "dogaltursu.com").
    source: z.string().nullish(),
  }),
]);
const featureContentSchema = z.looseObject({
  items: z.array(featureElementSchema).nullish(),
  references: z.array(featureElementSchema).nullish(),
});
type FeatureElement = z.infer<typeof featureElementSchema>;

const GOOGLE_HOST = /^google\.[a-z.]+$/;

/**
 * The element's site. A goto-wrapped element says "google.com", so its site
 * comes from the name Google shows, as for organic rows. Google itself is
 * never credited: a site that can't be told is left out.
 */
function elementHost(el: Exclude<FeatureElement, string>) {
  const { domain } = unwrapGoogleRedirect({
    url: el.url,
    domain: el.domain,
    website_name: el.source,
  });
  const site = domain?.toLowerCase().replace(/^www\./, "");
  return site && !GOOGLE_HOST.test(site) ? site : undefined;
}

const elementTitle = (el: FeatureElement) =>
  typeof el === "string" ? el : el.title;
const elementSite = (el: FeatureElement) =>
  typeof el === "string" ? el : elementHost(el);
/** "site: title"; the name Google shows stands in for an unknown domain. */
const elementSource = (el: FeatureElement) => {
  if (typeof el === "string") return el;
  const name = el.source?.trim();
  const site =
    elementHost(el) ??
    (name && !GOOGLE_HOST.test(name.toLowerCase()) ? name : undefined);
  return [site, el.title].filter(Boolean).join(": ");
};

function featureValues(type: string, item: unknown) {
  const parsed = featureContentSchema.safeParse(item);
  if (!parsed.success) return [];
  const { items, references } = parsed.data;
  switch (type) {
    case "people_also_ask":
    case "related_searches":
    case "people_also_search":
      return items?.map(elementTitle) ?? [];
    case "compare_sites":
      return items?.map(elementSite) ?? [];
    case "video":
    case "short_videos":
      return items?.map(elementSource) ?? [];
    case "ai_overview":
      return references?.map(elementSource) ?? [];
    default:
      return [];
  }
}

/** A SERP feature's content, bounded so a feature can't flood the response. */
export function featureDetails(item: { type: string }): string[] | null {
  const values = featureValues(item.type, item).filter(
    (value): value is string => Boolean(value),
  );
  const details = [...new Set(values)].slice(0, MAX_FEATURE_DETAILS);
  return details.length > 0
    ? details.map((value) => value.slice(0, 150))
    : null;
}
