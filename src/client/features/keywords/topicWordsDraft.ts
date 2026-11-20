import {
  sameTopicWords,
  splitTopicWords,
  topicWordsSchema,
} from "@/shared/topic-words";

// The decisions behind the research page's topic field, kept free of React so
// they read (and test) as plain rules. The field filters the current view; the
// project list changes only through an explicit save.

/** The field text last taken from the server, and the list it matched. */
export type TopicBaseline = { text: string; words: readonly string[] };

/** What the field's text means against the project's saved list. */
export function topicDraftState(
  text: string,
  saved: readonly string[],
  baseline: TopicBaseline | null,
) {
  const words = splitTopicWords(text);
  const valid = topicWordsSchema.safeParse(words).success;
  const differs = !sameTopicWords(words, saved);
  return {
    words,
    valid,
    differs,
    canSave: valid && differs,
    // Someone else (an agent, another tab) saved since the field last synced,
    // so a save here replaces their list.
    changedElsewhere:
      differs && baseline !== null && !sameTopicWords(baseline.words, saved),
  };
}

/**
 * How the field follows the saved list when it loads or changes. While the
 * field still shows the baseline text, the user has not edited since, so the
 * field takes the new list. An edited field keeps its text; once its words
 * match the list, that text becomes the new baseline.
 */
export function syncTopicField(params: {
  current: string;
  baseline: TopicBaseline | null;
  saved: readonly string[];
}): { fieldText: string | null; baseline: TopicBaseline | null } {
  const { current, baseline, saved } = params;
  if (baseline === null || current === baseline.text) {
    const text = saved.join(", ");
    return { fieldText: text, baseline: { text, words: saved } };
  }
  if (sameTopicWords(splitTopicWords(current), saved)) {
    return { fieldText: null, baseline: { text: current, words: saved } };
  }
  return { fieldText: null, baseline };
}
