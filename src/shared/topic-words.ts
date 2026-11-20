import { z } from "zod";
import { foldedTermKey } from "@/shared/text-match";

// A project's topic words: the keyword-research "Topic Words (any)" filter,
// saved per project. The app, the settings page and the MCP tool all validate
// with this schema and dedupe with dedupeTopicWords, so every writer stores the
// same list for the same input.

const TOPIC_WORD_MAX_CHARS = 40;
const TOPIC_WORDS_MAX = 50;

/** The rule in words, for form errors and the MCP tool description. */
export const TOPIC_WORDS_RULE = `Up to ${TOPIC_WORDS_MAX} words of 1-${TOPIC_WORD_MAX_CHARS} characters each. A word can't contain a comma, a plus sign or a line break: the topic filter reads those as separators.`;

const topicWordSchema = z
  .string()
  .trim()
  .min(1)
  .max(TOPIC_WORD_MAX_CHARS)
  .regex(/^[^,+\r\n]+$/, "A topic word can't contain , + or a line break.");

export const topicWordsSchema = z.array(topicWordSchema).max(TOPIC_WORDS_MAX);

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

/** Same words in the same order. */
export function sameTopicWords(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((word, index) => word === b[index]);
}
