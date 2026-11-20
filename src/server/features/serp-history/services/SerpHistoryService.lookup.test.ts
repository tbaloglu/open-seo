import { beforeAll, describe, expect, it, vi } from "vitest";
import { SerpHistoryService } from "./SerpHistoryService";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));

beforeAll(async () => {
  await testDb.seedProject();
  // Written by the old lower-casing (before the cutoff) and after it.
  await testDb.client.executeMultiple(`
    INSERT INTO rank_tracking_configs (id, project_id, domain, devices, serp_depth, language_code)
      VALUES ('tracker', 'project', 'openseo.so', 'mobile', 10, 'tr');
    INSERT INTO rank_tracking_keywords (id, config_id, keyword, match_case, created_at)
      VALUES ('upper', 'tracker', 'Turşu', 1, '2026-11-01 00:00:00'),
             ('lower', 'tracker', 'turşu', 0, '2026-11-01 00:00:00'),
             ('dotted', 'tracker', 'i\u0307stanbul avukat', 0, '2026-11-01 00:00:00'),
             ('isparta', 'tracker', 'isparta otel', 0, '2026-11-01 00:00:00'),
             ('kir', 'tracker', 'kir evi', 0, '2026-12-01 00:00:00');
  `);
});

const history = (input: { keyword?: string; trackingKeywordId?: string }) =>
  SerpHistoryService.getKeywordHistory({
    projectId: "project",
    projectDefaultDevice: "mobile",
    runs: 6,
    ...input,
  });

describe("SERP history keyword lookup", () => {
  it.each([
    ["by id", { trackingKeywordId: "lower" }, "lower"],
    ["the exact text before its lowercase twin", { keyword: "Turşu" }, "upper"],
    ["an older row with a stray dot", { keyword: "İstanbul avukat" }, "dotted"],
    ["what plain toLowerCase() stored", { keyword: "ISPARTA otel" }, "isparta"],
  ])("finds %s", async (_case, input, id) => {
    expect((await history(input)).keyword.id).toBe(id);
  });

  it.each([
    // "KIR evi" is "kır evi"; the newer "kir evi" row is another word.
    ["a newer row as an old lowercasing", { keyword: "KIR evi" }, "NOT_FOUND"],
    ["no keyword or id", { keyword: " " }, "VALIDATION_ERROR"],
  ])("rejects %s", async (_case, input, code) => {
    await expect(history(input)).rejects.toMatchObject({ code });
  });
});
