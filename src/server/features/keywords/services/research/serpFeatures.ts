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
// An AI Overview's sources can also sit on its nested elements.
const nestedReferencesSchema = z.looseObject({
  references: z.array(featureElementSchema).nullish(),
});

/** google.com, google.com.tr, maps.google.com, ... */
export const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$/;

function urlHost(url: string | null | undefined) {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The element's site. A goto-wrapped element says "google.com", so its site
 * comes from the name Google shows, as for organic rows. Google itself is
 * never credited: a site that can't be told is left out.
 */
function elementHost(el: Exclude<FeatureElement, string>) {
  const { domain } = unwrapGoogleRedirect({
    url: el.url,
    domain: el.domain || urlHost(el.url),
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

/** Each nested element as text, with its site when it names one. */
function featureEntries(type: string, item: unknown) {
  const parsed = featureContentSchema.safeParse(item);
  if (!parsed.success) return [];
  const { items, references } = parsed.data;
  const read = (
    elements: FeatureElement[] | null | undefined,
    text: (el: FeatureElement) => string | null | undefined,
  ) =>
    (elements ?? []).map((el) => ({
      value: text(el),
      domain: typeof el === "string" ? null : (elementHost(el) ?? null),
    }));
  switch (type) {
    case "people_also_ask":
    case "related_searches":
    case "people_also_search":
      return read(items, elementTitle);
    case "compare_sites":
      return read(items, elementSite);
    case "video":
    case "short_videos":
      return read(items, elementSource);
    case "ai_overview":
      return read(
        [
          ...(references ?? []),
          ...(items ?? []).flatMap((el) => {
            const nested = nestedReferencesSchema.safeParse(el);
            return nested.success ? (nested.data.references ?? []) : [];
          }),
        ],
        elementSource,
      );
    default:
      return [];
  }
}

/**
 * A SERP feature's values, each with the site it belongs to when known,
 * bounded so a feature can't flood a response or a stored SERP.
 */
export function featureContents(item: {
  type: string;
}): Array<{ value: string; domain: string | null }> {
  const seen = new Set<string>();
  const contents: Array<{ value: string; domain: string | null }> = [];
  for (const { value, domain } of featureEntries(item.type, item)) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    contents.push({ value: value.slice(0, 150), domain });
    if (contents.length === MAX_FEATURE_DETAILS) break;
  }
  return contents;
}

/** A SERP feature's content, bounded so a feature can't flood the response. */
export function featureDetails(item: { type: string }): string[] | null {
  const details = featureContents(item).map(({ value }) => value);
  return details.length > 0 ? details : null;
}
