import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { useLocalKeywordFilters } from "@/client/features/keywords/hooks/useLocalKeywordFilters";
import {
  syncTopicField,
  topicDraftState,
  type TopicBaseline,
} from "@/client/features/keywords/topicWordsDraft";
import { getTopicWords, setTopicWords } from "@/serverFunctions/topic-words";

export const topicWordsQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["topicWords", projectId],
    queryFn: () => getTopicWords({ data: { projectId } }),
    // Nothing writes in the background, so a fresh read can only help: an
    // agent or another tab may have changed the list.
    staleTime: 0,
  });

/**
 * Saves a project's topic words. A refetch already in flight could land after
 * the save with the old list, so it is cancelled first.
 */
export function useSaveTopicWords(projectId: string) {
  const queryClient = useQueryClient();
  const { queryKey } = topicWordsQueryOptions(projectId);
  return useMutation({
    mutationFn: (words: string[]) =>
      setTopicWords({ data: { projectId, words } }),
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: (words) => queryClient.setQueryData(queryKey, words),
  });
}

type FiltersForm = ReturnType<typeof useLocalKeywordFilters>["filtersForm"];

/**
 * The research page's "Topic Words (any)" field starts from the project's
 * saved list and then filters only the current view. The list changes only
 * when the user presses save.
 *
 * The keywords route remounts per project (remountDeps), so the baseline here
 * never carries over from another project.
 */
export function useProjectTopicWords(projectId: string, form: FiltersForm) {
  const query = useQuery(topicWordsQueryOptions(projectId));
  const saved = query.data;
  const topics = useStore(form.store, (state) => state.values.topics);
  // State for rendering, mirrored in a ref so the sync below runs only when
  // the server list changes.
  const [baseline, setBaselineState] = useState<TopicBaseline | null>(null);
  const baselineRef = useRef<TopicBaseline | null>(null);
  const setBaseline = useCallback((next: TopicBaseline | null) => {
    baselineRef.current = next;
    setBaselineState(next);
  }, []);

  const mutation = useSaveTopicWords(projectId);
  const { mutate } = mutation;

  useEffect(() => {
    if (!saved) return;
    const next = syncTopicField({
      current: form.state.values.topics,
      baseline: baselineRef.current,
      saved,
    });
    if (next.fieldText !== null) form.setFieldValue("topics", next.fieldText);
    if (next.baseline !== baselineRef.current) setBaseline(next.baseline);
  }, [form, saved, setBaseline]);

  const draft = topicDraftState(topics, saved ?? [], baseline);

  const save = useCallback(() => {
    if (!draft.canSave || mutation.isPending) return;
    mutate(draft.words, {
      onSuccess: () => toast.success("Topic words saved for this project"),
    });
  }, [draft.canSave, draft.words, mutate, mutation.isPending]);

  const resetToSaved = useCallback(() => {
    if (!saved) return;
    const text = saved.join(", ");
    form.setFieldValue("topics", text);
    setBaseline({ text, words: saved });
  }, [form, saved, setBaseline]);

  const loaded = saved !== undefined;
  return {
    loaded,
    valid: draft.valid,
    differs: loaded && draft.differs,
    changedElsewhere: loaded && draft.changedElsewhere,
    canSave: loaded && draft.canSave && !mutation.isPending,
    isSaving: mutation.isPending,
    save,
    resetToSaved,
  };
}
