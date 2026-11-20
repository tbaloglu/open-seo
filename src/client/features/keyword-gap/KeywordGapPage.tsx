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
import { getKeywordGap } from "@/serverFunctions/keyword-gap";
import { parseCompetitorDomain } from "@/shared/researchScope";

export function KeywordGapPage({
  projectId,
  competitor,
  locationCode,
  sentLocationCode,
  onSearch,
}: {
  projectId: string;
  /** The raw `competitor` URL param. */
  competitor: string;
  /** The market the location select shows. */
  locationCode: number;
  /** Only an explicit choice is sent; otherwise the server uses the project's market. */
  sentLocationCode: number | undefined;
  onSearch: (values: { competitor: string; locationCode: number }) => void;
}) {
  // The same check as the form, so a hand-edited URL never reaches the
  // paid call; the normalized domain keeps the cache key stable.
  const parsed = competitor.trim() ? parseCompetitorDomain(competitor) : null;
  const domain = parsed?.ok ? parsed.target.display : "";
  const gapQuery = useQuery({
    enabled: domain !== "",
    queryKey: ["keyword-gap", projectId, domain, sentLocationCode],
    queryFn: () =>
      getKeywordGap({
        data: {
          projectId,
          competitorDomain: domain,
          locationCode: sentLocationCode,
        },
      }),
    staleTime: 5 * 60_000,
    // Each run is billed: only the user's Search or Retry starts one.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    refetchOnMount: false,
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
          competitor={domain || competitor}
          locationCode={locationCode}
          urlError={parsed && !parsed.ok ? parsed.message : null}
          pending={gapQuery.isFetching}
          onSearch={onSearch}
        />

        {domain === "" ? (
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
            key={[
              projectId,
              result.competitor,
              result.locationCode,
              result.languageCode,
              result.siteUrl,
            ].join("|")}
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
  urlError,
  pending,
  onSearch,
}: {
  competitor: string;
  locationCode: number;
  /** Why the competitor in the URL was not searched. */
  urlError: string | null;
  pending: boolean;
  onSearch: (values: { competitor: string; locationCode: number }) => void;
}) {
  const form = useForm({
    defaultValues: { competitor, locationCode },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = parseCompetitorDomain(value.competitor);
        return parsed.ok
          ? null
          : createFormValidationErrors({
              fields: { competitor: parsed.message },
            });
      },
    },
    onSubmit: ({ value }) => {
      const parsed = parseCompetitorDomain(value.competitor);
      if (!parsed.ok) return;
      onSearch({
        competitor: parsed.target.display,
        locationCode: value.locationCode,
      });
    },
  });

  // Back/forward changes the competitor; the project's market arriving
  // changes only the location, so a typed competitor survives it.
  useEffect(() => {
    form.setFieldValue("competitor", competitor);
    // A submit error belongs to the value it was raised for.
    form.setFieldMeta("competitor", (meta) => ({ ...meta, errorMap: {} }));
  }, [form, competitor]);
  useEffect(() => {
    form.setFieldValue("locationCode", locationCode);
  }, [form, locationCode]);

  const formError = useStore(form.store, (state) =>
    getFieldError(state.fieldMeta.competitor?.errors ?? []),
  );
  const error = formError ?? urlError;

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
