import { z } from "zod";
import { foldedTermKey } from "@/shared/text-match";

// A project's topic words: the keyword-research "Topic Words (any)" filter,
// saved per project. The app, the settings page and the MCP tool all validate
// with this schema and dedupe with dedupeTopicWords, so every writer stores the
// same list for the same input.

export const TOPIC_WORD_MAX_CHARS = 40;
export const TOPIC_WORDS_MAX = 50;

export const topicWordsSchema = z
  .array(z.string().trim().min(1).max(TOPIC_WORD_MAX_CHARS))
  .max(TOPIC_WORDS_MAX);

/**
 * Trimmed, without empty entries, and one entry per word under Turkish-aware
 * folding (i, I, ı and İ are one letter; case is ignored), keeping the
 * spelling and position of the first occurrence.
 */
export function dedupeTopicWords(words: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const raw of words) {
    const word = raw.trim();
    const key = foldedTermKey(word);
    if (key && !byKey.has(key)) byKey.set(key, word);
  }
  return [...byKey.values()];
}

/**
 * The words in a comma-separated field, split the way the topic filter reads
 * it (commas and plus signs separate words).
 */
export function splitTopicWords(value: string): string[] {
  return dedupeTopicWords(value.split(/[,+]/));
}
