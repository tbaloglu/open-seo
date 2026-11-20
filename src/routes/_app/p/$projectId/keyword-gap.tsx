import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { KeywordGapPage } from "@/client/features/keyword-gap/KeywordGapPage";
import { useProjectMarket } from "@/client/features/projects/useProjectMarket";
import { pageHead } from "@/client/lib/pageHead";
import {
  DEFAULT_LOCATION_CODE,
  isLabsLocationCode,
  isLanguageServedForLocation,
} from "@/shared/keyword-locations";
import { keywordGapSearchSchema } from "@/types/schemas/keyword-gap";

export const Route = createFileRoute("/_app/p/$projectId/keyword-gap")({
  head: () => pageHead("Keyword Gap"),
  validateSearch: keywordGapSearchSchema,
  component: KeywordGapRoute,
});

function KeywordGapRoute() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const { competitor = "", loc } = Route.useSearch();
  const projectMarket = useProjectMarket(projectId);
  // Competitor keywords come from Labs; the server falls back to the United
  // States for a project market Labs can't serve, so the select does too.
  const defaultLocationCode =
    projectMarket &&
    isLabsLocationCode(projectMarket.locationCode) &&
    isLanguageServedForLocation(
      projectMarket.locationCode,
      projectMarket.languageCode,
    )
      ? projectMarket.locationCode
      : DEFAULT_LOCATION_CODE;
  const sentLocationCode =
    loc != null && isLabsLocationCode(loc) ? loc : undefined;

  return (
    <KeywordGapPage
      projectId={projectId}
      competitor={competitor}
      locationCode={sentLocationCode ?? defaultLocationCode}
      sentLocationCode={sentLocationCode}
      onSearch={(values) => {
        void navigate({
          search: {
            competitor: values.competitor,
            loc:
              values.locationCode === defaultLocationCode
                ? undefined
                : values.locationCode,
          },
        });
      }}
    />
  );
}
