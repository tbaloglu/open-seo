import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { KeywordGapPage } from "@/client/features/keyword-gap/KeywordGapPage";
import {
  DEFAULT_LOCATION_CODE,
  isLabsLocationCode,
} from "@/client/features/keywords/locations";
import { useProjectMarket } from "@/client/features/projects/useProjectMarket";
import { pageHead } from "@/client/lib/pageHead";
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
  // Competitor keywords come from Labs, so only Labs countries are valid.
  const defaultLocationCode =
    projectMarket && isLabsLocationCode(projectMarket.locationCode)
      ? projectMarket.locationCode
      : DEFAULT_LOCATION_CODE;
  const sentLocationCode =
    loc != null && isLabsLocationCode(loc) ? loc : undefined;

  return (
    <KeywordGapPage
      projectId={projectId}
      competitor={competitor.trim()}
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
