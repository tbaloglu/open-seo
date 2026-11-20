import { useEffect } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@/client/components/EmptyState";
import { LocationSelect } from "@/client/components/LocationSelect";
import { PageHeader } from "@/client/components/PageHeader";
import { QueryError } from "@/client/components/QueryState";
import { SearchCard, SearchInput } from "@/client/components/SearchCard";
import { SkeletonCard } from "@/client/components/SkeletonPresets";
import { GoogleConnectionCard } from "@/client/features/integrations/GoogleConnectionCard";
import { GapResults } from "@/client/features/keyword-gap/GapResults";
import { LABS_LOCATION_OPTIONS } from "@/client/features/keywords/locations";
import { createFormValidationErrors, getFieldError } from "@/client/lib/forms";
import { getErrorCode } from "@/client/lib/error-messages";
import { getKeywordGap } from "@/serverFunctions/keyword-gap";
import { parseResearchTarget } from "@/shared/researchScope";

function competitorError(value: string): string | null {
  const parsed = parseResearchTarget(value);
  if (!parsed.ok) return parsed.message;
  if (parsed.target.path !== "") {
    return "Use the competitor's domain without a path, like example.com.";
  }
  return null;
}

export function KeywordGapPage({
  projectId,
  competitor,
  locationCode,
  sentLocationCode,
  onSearch,
}: {
  projectId: string;
  competitor: string;
  /** The market the location select shows. */
  locationCode: number;
  /** Only an explicit choice is sent; otherwise the server uses the project's market. */
  sentLocationCode: number | undefined;
  onSearch: (values: { competitor: string; locationCode: number }) => void;
}) {
  const gapQuery = useQuery({
    enabled: competitor !== "",
    queryKey: ["keyword-gap", projectId, competitor, sentLocationCode],
    queryFn: () =>
      getKeywordGap({
        data: {
          projectId,
          competitorDomain: competitor,
          locationCode: sentLocationCode,
        },
      }),
    staleTime: 5 * 60_000,
    // Out of credits, a retry cannot succeed, so show the get-credits card now.
    retry: (failureCount, error) =>
      failureCount < 3 && getErrorCode(error) !== "INSUFFICIENT_CREDITS",
  });
  const result = gapQuery.data;

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title="Keyword Gap"
          description="Keywords a competitor ranks for where your site has no Search Console impressions or ranks worse than position 20."
        />
        <GapSearchCard
          competitor={competitor}
          locationCode={locationCode}
          pending={gapQuery.isFetching}
          onSearch={onSearch}
        />

        {competitor === "" ? (
          <EmptyState
            kind="no-data"
            title="Compare a competitor with your site"
            description="Enter a competitor's domain. Their top-30 organic keywords are compared with your Search Console queries from the last 3 months."
          />
        ) : gapQuery.isPending ? (
          <SkeletonCard />
        ) : gapQuery.isError ? (
          <QueryError
            error={gapQuery.error}
            fallback="Couldn't load the keyword gap."
            onRetry={() => void gapQuery.refetch()}
            isRetrying={gapQuery.isFetching}
          />
        ) : !result ? null : !result.connected ? (
          <div className="max-w-2xl">
            <GoogleConnectionCard
              provider="gsc"
              projectId={projectId}
              prominent
            />
          </div>
        ) : (
          <GapResults
            // A new comparison starts on page one with nothing selected.
            key={`${result.competitor}-${result.locationCode}`}
            projectId={projectId}
            result={result}
          />
        )}
      </div>
    </div>
  );
}

function GapSearchCard({
  competitor,
  locationCode,
  pending,
  onSearch,
}: {
  competitor: string;
  locationCode: number;
  pending: boolean;
  onSearch: (values: { competitor: string; locationCode: number }) => void;
}) {
  const form = useForm({
    defaultValues: { competitor, locationCode },
    validators: {
      onSubmit: ({ value }) => {
        const message = competitorError(value.competitor);
        return message
          ? createFormValidationErrors({ fields: { competitor: message } })
          : null;
      },
    },
    onSubmit: ({ value }) =>
      onSearch({
        competitor: value.competitor.trim(),
        locationCode: value.locationCode,
      }),
  });

  // Back/forward and the project's market arriving change the URL state.
  useEffect(() => {
    form.reset({ competitor, locationCode });
  }, [form, competitor, locationCode]);

  const error = useStore(form.store, (state) =>
    getFieldError(state.fieldMeta.competitor?.errors ?? []),
  );

  return (
    <SearchCard
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
      pending={pending}
      error={error}
      errorId="keyword-gap-competitor-error"
      secondRow={
        <p className="text-xs text-muted-foreground">
          Uses credits: one DataForSEO Labs request billed per competitor
          keyword read (up to 1,000, about 15–170 credits). Results are cached
          for 12 hours. Requires a connected Search Console property, which is
          checked first.
        </p>
      }
    >
      <form.Field name="competitor">
        {(field) => (
          <SearchInput
            placeholder="Competitor domain, e.g. example.com"
            aria-label="Competitor domain"
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={
              error ? "keyword-gap-competitor-error" : undefined
            }
          />
        )}
      </form.Field>
      <form.Field name="locationCode">
        {(field) => (
          <LocationSelect
            value={field.state.value}
            options={LABS_LOCATION_OPTIONS}
            className="w-full lg:w-44 lg:shrink-0"
            onChange={(code) => field.handleChange(code)}
          />
        )}
      </form.Field>
    </SearchCard>
  );
}
