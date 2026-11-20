import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopicWordsService } from "./TopicWordsService";

// Real SQLite with every migration applied, so the replace runs against the
// production table and its (project_id, word) key.
const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));

beforeEach(async () => {
  await testDb.seedProject();
  await testDb.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('other', 'organization', 'Other')",
  );
});

describe("TopicWordsService", () => {
  it("replaces the whole list, in order, and clears it with an empty one", async () => {
    // More rows than one insert statement carries.
    const many = Array.from({ length: 45 }, (_, index) => `word${index}`);
    await TopicWordsService.setTopicWords("project", many);
    expect(await TopicWordsService.getTopicWords("project")).toEqual(many);

    await TopicWordsService.setTopicWords("project", ["kavanoz", "salamura"]);
    expect(await TopicWordsService.getTopicWords("project")).toEqual([
      "kavanoz",
      "salamura",
    ]);

    await TopicWordsService.setTopicWords("project", []);
    expect(await TopicWordsService.getTopicWords("project")).toEqual([]);
  });

  it("stores a word once under Turkish folding, keeping the first spelling", async () => {
    const stored = await TopicWordsService.setTopicWords("project", [
      " İstanbul ",
      "ISTANBUL",
      "ıstanbul",
      "Turşu",
      "turşu",
      "şeker",
      "seker",
    ]);

    expect(stored).toEqual(["İstanbul", "Turşu", "şeker", "seker"]);
    expect(await TopicWordsService.getTopicWords("project")).toEqual(stored);
  });

  it("reads and replaces only the given project's words", async () => {
    await TopicWordsService.setTopicWords("other", ["rakip"]);
    await TopicWordsService.setTopicWords("project", ["turşu"]);
    await TopicWordsService.setTopicWords("project", ["kavanoz"]);

    expect(await TopicWordsService.getTopicWords("other")).toEqual(["rakip"]);
    expect(await TopicWordsService.getTopicWords("project")).toEqual([
      "kavanoz",
    ]);
  });
});
