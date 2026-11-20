import { asc, eq } from "drizzle-orm";
import { chunk } from "remeda";
import { db } from "@/db";
import type { runBatch } from "@/db/runBatch";
import { projectTopicWords } from "@/db/schema";

// Every query filters on `project_id`; callers authorize the project first.

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];

// D1 binds at most 100 parameters per statement; the table has 3 columns.
const ROWS_PER_INSERT = 30;

async function listWords(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ word: projectTopicWords.word })
    .from(projectTopicWords)
    .where(eq(projectTopicWords.projectId, projectId))
    .orderBy(asc(projectTopicWords.sortOrder));
  return rows.map((row) => row.word);
}

/**
 * Statements that make `words` the project's whole list, in order. Run them in
 * one runBatch so a failed insert leaves the old list in place.
 */
function replaceWords(
  tx: Tx,
  projectId: string,
  words: string[],
): Promise<unknown>[] {
  const rows = words.map((word, sortOrder) => ({ projectId, word, sortOrder }));
  return [
    tx
      .delete(projectTopicWords)
      .where(eq(projectTopicWords.projectId, projectId)),
    ...chunk(rows, ROWS_PER_INSERT).map((batch) =>
      tx.insert(projectTopicWords).values(batch),
    ),
  ];
}

export const TopicWordsRepository = { listWords, replaceWords } as const;
