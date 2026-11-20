import { runBatch } from "@/db/runBatch";
import { TopicWordsRepository } from "@/server/features/topic-words/repositories/TopicWordsRepository";
import { dedupeTopicWords } from "@/shared/topic-words";

// A project's saved topic words. Input is validated with topicWordsSchema at
// the entry point (server function or MCP tool); this dedupes and stores it.

function getTopicWords(projectId: string): Promise<string[]> {
  return TopicWordsRepository.listWords(projectId);
}

/** Replaces the project's whole list and returns what was stored. */
async function setTopicWords(
  projectId: string,
  words: string[],
): Promise<string[]> {
  const deduped = dedupeTopicWords(words);
  await runBatch((tx) =>
    TopicWordsRepository.replaceWords(tx, projectId, deduped),
  );
  return deduped;
}

export const TopicWordsService = { getTopicWords, setTopicWords } as const;
