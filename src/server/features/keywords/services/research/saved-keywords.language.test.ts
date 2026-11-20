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

// Written by the old lower-casing, and after it.
const BEFORE_CUTOFF = "2026-11-01 00:00:00";
const AFTER_CUTOFF = "2026-12-01 00:00:00";

async function save(keywords: string[], languageCode = "tr") {
  return saveKeywords({
    organizationId: "organization",
    projectId: "project",
    keywords,
    locationCode: 2792,
    languageCode,
  });
}

async function seed(rows: [id: string, keyword: string, createdAt: string][]) {
  for (const [id, keyword, createdAt] of rows) {
    await testDb.client.execute({
      sql: `INSERT INTO saved_keywords (id, project_id, keyword, location_code, language_code, created_at)
        VALUES (?, 'project', ?, 2792, 'tr', ?)`,
      args: [id, keyword, createdAt],
    });
  }
}

async function storedKeywords() {
  const { rows } = await testDb.client.execute(
    "SELECT keyword FROM saved_keywords ORDER BY keyword",
  );
  return rows.map((row) => row.keyword);
}

async function listSaved(search?: string) {
  const { rows } = await getSavedKeywords({
    projectId: "project",
    search,
    page: 1,
    pageSize: 50,
    sort: "keyword",
    order: "asc",
  });
  return rows;
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

  it("keeps Turkish i and ı words apart, both ways and in one save", async () => {
    await seed([
      ["kir", "kir düğünü", AFTER_CUTOFF],
      ["tip", "tip fakültesi", AFTER_CUTOFF],
    ]);

    await save(["kır düğünü", "tıp fakültesi"]);
    await save(["kil", "kıl", "sınav", "sinav"]);

    expect(await storedKeywords()).toEqual([
      "kil",
      "kir düğünü",
      "kıl",
      "kır düğünü",
      "sinav",
      "sınav",
      "tip fakültesi",
      "tıp fakültesi",
    ]);
  });

  it("reuses a row the old lowercasing wrote for the same input", async () => {
    await seed([
      ["dotted", "i\u0307stanbul turşucu", BEFORE_CUTOFF],
      ["isparta", "isparta oteli", BEFORE_CUTOFF],
      ["kir", "kir evi", AFTER_CUTOFF],
    ]);

    const first = await save([
      "İstanbul turşucu",
      "Isparta oteli",
      // A row from after the cutoff is the word "kir", not an old "KIR".
      "KIR evi",
    ]);
    const second = await save(["istanbul turşucu"]);

    expect(first.savedKeywordIds).toEqual(
      expect.arrayContaining(["dotted", "isparta"]),
    );
    expect(second.savedKeywordIds).toEqual(["dotted"]);
    expect(await storedKeywords()).toEqual([
      "isparta oteli",
      "i\u0307stanbul turşucu",
      "kir evi",
      "kır evi",
    ]);
  });

  it("never reuses an old row for a word asked for in the same save", async () => {
    await seed([["kir", "kir düğünü", BEFORE_CUTOFF]]);

    await save(["kir düğünü", "KIR düğünü"]);

    expect(await storedKeywords()).toEqual(["kir düğünü", "kır düğünü"]);
  });

  it("shows research metrics on an old row the keyword is saved onto", async () => {
    await seed([["dotted", "i\u0307stanbul avukat", BEFORE_CUTOFF]]);
    await testDb.client.execute(`
      INSERT INTO keyword_metrics (project_id, keyword, location_code, language_code, search_volume)
      VALUES ('project', 'istanbul avukat', 2792, 'tr', 880)`);

    await save(["İstanbul avukat"]);

    expect(await listSaved()).toEqual([
      expect.objectContaining({ id: "dotted", searchVolume: 880 }),
    ]);
  });

  it("finds keywords whatever i-letter the search uses", async () => {
    await seed([
      ["dotted", "i\u0307stanbul turşucu", BEFORE_CUTOFF],
      ["red", "kırmızı elbise", BEFORE_CUTOFF],
    ]);

    expect((await listSaved("istanbul")).map((row) => row.id)).toEqual([
      "dotted",
    ]);
    expect((await listSaved("KIRMIZI")).map((row) => row.id)).toEqual(["red"]);
  });
});
