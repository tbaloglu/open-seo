import { useEffect, useRef } from "react";
import { useStore } from "@tanstack/react-form";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  clearLegacyTopics,
  readLegacyTopics,
  type useLocalKeywordFilters,
} from "@/client/features/keywords/hooks/useLocalKeywordFilters";
import { getTopicWords, setTopicWords } from "@/serverFunctions/topic-words";
import {
  splitTopicWords,
  TOPIC_WORD_MAX_CHARS,
  TOPIC_WORDS_MAX,
} from "@/shared/topic-words";

export const topicWordsQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["topicWords", projectId],
    queryFn: () => getTopicWords({ data: { projectId } }),
  });

// Long enough to save once the user stops typing, not on every keystroke.
const SAVE_DELAY_MS = 800;

type FiltersForm = ReturnType<typeof useLocalKeywordFilters>["filtersForm"];

/**
 * The research page's "Topic Words (any)" field is the project's saved list:
 * it starts from the server's words, and an edit is saved back once typing
 * stops. Topic words this browser kept before they moved to the server are
 * uploaded once, when the project has none yet.
 */
export function useProjectTopicWords(projectId: string, form: FiltersForm) {
  const queryClient = useQueryClient();
  const query = useQuery(topicWordsQueryOptions(projectId));
  const saved = query.data;
  const topics = useStore(form.store, (state) => state.values.topics);
  // The project whose words are in the field. Saving waits for it, so the
  // empty field before the first load never overwrites the saved list.
  const loadedFor = useRef<string | null>(null);

  const mutation = useMutation({
    mutationFn: (words: string[]) =>
      setTopicWords({ data: { projectId, words } }),
    onSuccess: (words) =>
      queryClient.setQueryData(
        topicWordsQueryOptions(projectId).queryKey,
        words,
      ),
  });
  const { mutate: save } = mutation;

  useEffect(() => {
    if (!saved || loadedFor.current === projectId) return;
    loadedFor.current = projectId;
    const legacy = readLegacyTopics(projectId);
    if (saved.length > 0 || legacy.trim() === "") {
      if (legacy) clearLegacyTopics(projectId);
      form.setFieldValue("topics", saved.join(", "));
      return;
    }
    // Trimmed to what the server accepts, so the one-time upload cannot fail
    // validation and be retried on every visit.
    const words = splitTopicWords(legacy)
      .filter((word) => word.length <= TOPIC_WORD_MAX_CHARS)
      .slice(0, TOPIC_WORDS_MAX);
    form.setFieldValue("topics", words.join(", "));
    save(words, { onSuccess: () => clearLegacyTopics(projectId) });
  }, [form, projectId, save, saved]);

  useEffect(() => {
    if (!saved || loadedFor.current !== projectId) return;
    // Read from the form, not `topics`: in the render that loaded the saved
    // words, `topics` still holds the empty value from before.
    const words = splitTopicWords(form.state.values.topics);
    if (words.join("\n") === saved.join("\n")) return;
    const timer = setTimeout(() => save(words), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [form, projectId, save, saved, topics]);
}
