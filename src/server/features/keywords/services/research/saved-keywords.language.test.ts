import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSavedKeywords, saveKeywords } from "./saved-keywords";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
}));

const market = { locationCode: 2792, languageCode: "tr" };

async function save(keywords: string[], languageCode = "tr") {
  return saveKeywords({
    organizationId: "organization",
    projectId: "project",
    keywords,
    locationCode: market.locationCode,
    languageCode,
  });
}

async function storedKeywords() {
  const { rows } = await testDb.client.execute(
    "SELECT keyword FROM saved_keywords ORDER BY keyword",
  );
  return rows.map((row) => row.keyword);
}

beforeEach(async () => {
  await testDb.seedProject();
});

describe("saved keywords in the project language", () => {
  it("lowercases Turkish keywords as Turkish and English ones as before", async () => {
    await save(["KIRMIZI elbise", "İstanbul", "ISPARTA"]);
    await save(["TITLE", "İzmir"], "en");

    expect(await storedKeywords()).toEqual([
      "istanbul",
      "izmir",
      "kırmızı elbise",
      "title",
      "ısparta",
    ]);
  });

  it("updates a row saved with the old lowercasing instead of adding a twin", async () => {
    await testDb.client.execute(`
      INSERT INTO saved_keywords (id, project_id, keyword, location_code, language_code)
      VALUES ('dotted', 'project', 'i̇stanbul turşucu', 2792, 'tr'),
             ('dotless', 'project', 'isparta oteli', 2792, 'tr'),
             ('field', 'project', 'kır düğünü', 2792, 'tr')`);

    const result = await save([
      "İstanbul turşucu",
      "Isparta oteli",
      // "kir" (dirt) is not "kır" (field): a new keyword.
      "kir düğünü",
    ]);

    expect(result.savedKeywordIds).toEqual(
      expect.arrayContaining(["dotted", "dotless"]),
    );
    expect(await storedKeywords()).toEqual([
      "isparta oteli",
      "i̇stanbul turşucu",
      "kir düğünü",
      "kır düğünü",
    ]);
  });

  it("finds keywords whatever i-letter the search uses", async () => {
    await testDb.client.execute(`
      INSERT INTO saved_keywords (id, project_id, keyword, location_code, language_code)
      VALUES ('dotted', 'project', 'i̇stanbul turşucu', 2792, 'tr'),
             ('red', 'project', 'kırmızı elbise', 2792, 'tr')`);

    const search = async (term: string) =>
      (await getSavedKeywords({ projectId: "project", search: term })).rows.map(
        (row) => row.id,
      );

    expect(await search("istanbul")).toEqual(["dotted"]);
    expect(await search("KIRMIZI")).toEqual(["red"]);
  });
});
