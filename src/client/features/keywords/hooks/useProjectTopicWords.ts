import { useCallback, useEffect, useRef } from "react";
import { useStore } from "@tanstack/react-form";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  clearLegacyTopics,
  readLegacyTopics,
  type useLocalKeywordFilters,
} from "@/client/features/keywords/hooks/useLocalKeywordFilters";
import {
  planLegacyTopicUpload,
  syncTopicField,
  topicDraftState,
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

type FiltersForm = ReturnType<typeof useLocalKeywordFilters>["filtersForm"];

function migrationKey(projectId: string) {
  return `keyword-topic-words-migrated:${projectId}`;
}

/** Marks the one-time upload as tried; false when it was tried before. */
function claimLegacyMigration(projectId: string) {
  try {
    if (localStorage.getItem(migrationKey(projectId))) return false;
    localStorage.setItem(migrationKey(projectId), "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * The research page's "Topic Words (any)" field starts from the project's
 * saved list and then filters only the current view. The list changes only
 * when the user presses save. Topic words this browser kept before they moved
 * to the server are uploaded once, when the project has none yet.
 */
export function useProjectTopicWords(projectId: string, form: FiltersForm) {
  const queryClient = useQueryClient();
  const query = useQuery(topicWordsQueryOptions(projectId));
  const saved = query.data;
  const topics = useStore(form.store, (state) => state.values.topics);
  // The text the field last took from the server, per project.
  const synced = useRef<{ projectId: string; text: string } | null>(null);

  const mutation = useMutation({
    mutationFn: (words: string[]) =>
      setTopicWords({ data: { projectId, words } }),
    onSuccess: (words) =>
      queryClient.setQueryData(
        topicWordsQueryOptions(projectId).queryKey,
        words,
      ),
  });
  const { mutate } = mutation;

  useEffect(() => {
    if (!saved) return;
    const firstSync = synced.current?.projectId !== projectId;
    const next = syncTopicField({
      current: form.state.values.topics,
      synced: firstSync ? null : (synced.current?.text ?? null),
      saved,
    });
    if (next.fieldText !== null) form.setFieldValue("topics", next.fieldText);
    synced.current =
      next.synced === null ? null : { projectId, text: next.synced };
    if (!firstSync) return;

    const legacy = planLegacyTopicUpload(readLegacyTopics(projectId), saved);
    if (legacy.kind === "clear") clearLegacyTopics(projectId);
    if (legacy.kind === "upload" && claimLegacyMigration(projectId)) {
      const text = legacy.words.join(", ");
      form.setFieldValue("topics", text);
      synced.current = { projectId, text };
      mutate(legacy.words, { onSuccess: () => clearLegacyTopics(projectId) });
    }
  }, [form, mutate, projectId, saved]);

  const draft = topicDraftState(topics, saved ?? []);

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
    synced.current = { projectId, text };
  }, [form, projectId, saved]);

  return {
    loaded: saved !== undefined,
    valid: draft.valid,
    differs: saved !== undefined && draft.differs,
    canSave: saved !== undefined && draft.canSave && !mutation.isPending,
    isSaving: mutation.isPending,
    save,
    resetToSaved,
  };
}
