import {
  isValidTopicWord,
  sameTopicWords,
  splitTopicWords,
  TOPIC_WORDS_MAX,
  topicWordsSchema,
} from "@/shared/topic-words";

// The decisions behind the research page's topic field, kept free of React so
// they read (and test) as plain rules. The field filters the current view; the
// project list changes only through an explicit save.

/** What the field's text means against the project's saved list. */
export function topicDraftState(text: string, saved: readonly string[]) {
  const words = splitTopicWords(text);
  const valid = topicWordsSchema.safeParse(words).success;
  const differs = !sameTopicWords(words, saved);
  return { words, valid, differs, canSave: valid && differs };
}

/**
 * How the field follows the saved list when it loads or changes. `synced` is
 * the text the field last took from the server. While the field still shows
 * it, the user has not edited since, so the field takes the new list. An
 * edited field keeps its text; once its words match the list, that text
 * becomes the new synced baseline.
 */
export function syncTopicField(params: {
  current: string;
  synced: string | null;
  saved: readonly string[];
}): { fieldText: string | null; synced: string | null } {
  const { current, synced, saved } = params;
  if (synced === null || current === synced) {
    const text = saved.join(", ");
    return { fieldText: text, synced: text };
  }
  if (sameTopicWords(splitTopicWords(current), saved)) {
    return { fieldText: null, synced: current };
  }
  return { fieldText: null, synced };
}

/**
 * What to do with topic words this browser kept before they moved to the
 * server. Only a project with no saved words takes them; words the server
 * would refuse are dropped first, so the one upload cannot fail validation.
 */
export function planLegacyTopicUpload(
  legacy: string,
  saved: readonly string[],
): { kind: "none" } | { kind: "clear" } | { kind: "upload"; words: string[] } {
  if (legacy.trim() === "") return { kind: "none" };
  if (saved.length > 0) return { kind: "clear" };
  const words = splitTopicWords(legacy)
    .filter(isValidTopicWord)
    .slice(0, TOPIC_WORDS_MAX);
  return words.length > 0 ? { kind: "upload", words } : { kind: "clear" };
}
