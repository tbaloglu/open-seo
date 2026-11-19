import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSerpResultsTool } from "./get-serp-results";
import { makeToolContext, textContent } from "./tool-test-support";
import { serpSchema } from "@/shared/mcp-contracts";
import type * as r2CacheModule from "@/server/lib/r2-cache";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  fetchSerpTaskResult: vi.fn(),
  getProjectForOrganization: vi.fn(),
  cache: new Map<string, unknown>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/r2-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof r2CacheModule>()),
  getCached: async (key: string) => mocks.cache.get(key) ?? null,
  setCached: async (key: string, value: unknown) => {
    mocks.cache.set(key, value);
  },
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
  fetchSerpTaskResult: mocks.fetchSerpTaskResult,
  SERP_ANALYSIS_DEPTH: 10,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();
const args = { projectId: "project_1", queries: [{ keyword: "seo tools" }] };

function organic(position: number, domain: string | null, title = "Page") {
  return {
    type: "organic",
    rank_group: position,
    rank_absolute: position + 1,
    title,
    url: `https://${domain}/`,
    domain,
    description: "desc",
  };
}

/** Each query posts reads "t1".."t3"; `reads` answers them by task id. */
function mockReads(reads: Record<string, unknown>) {
  const post = vi.fn<(input: unknown) => Promise<string[]>>(async () =>
    Object.keys(reads),
  );
  mocks.createDataforseoClient.mockReturnValue({
    serp: {
      readsTaskPostBatch: (inputs: unknown[]) =>
        Promise.allSettled(inputs.map((input) => post(input))),
    },
  });
  mocks.fetchSerpTaskResult.mockImplementation(async (id: string) => reads[id]);
  return post;
}

const completed = (...items: unknown[]) => ({ status: "completed", items });

/** Runs fake time forward until a call that's polling has answered. */
async function untilAnswered<T>(call: Promise<T>) {
  const state = { answered: false };
  void call.finally(() => {
    state.answered = true;
  });
  while (!state.answered) await vi.advanceTimersByTimeAsync(3000);
  return call;
}

function itemsOf(result: { structuredContent?: unknown }) {
  const [first] = serpSchema.parse(result.structuredContent).results;
  if (!first.ok) throw new Error(first.error);
  return first.items;
}

describe("get_serp_results", () => {
  beforeEach(() => {
    mocks.cache.clear();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
      defaultDevice: "mobile",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges the reads: sites they agree on first, each at its best position", async () => {
    mockReads({
      t1: completed(organic(1, "poisoned.example"), organic(4, "agreed.com")),
      // A goto row's breadcrumb host has no www, but it's the same site.
      t2: completed(organic(2, "www.agreed.com"), organic(3, "second.com")),
      t3: completed(organic(5, "agreed.com"), organic(6, "second.com")),
    });

    const result = await getSerpResultsTool.handler(args, toolContext);

    expect(
      itemsOf(result).map(({ rank, domain, bestPosition, seenIn }) => [
        rank,
        domain,
        bestPosition,
        seenIn,
      ]),
    ).toEqual([
      [1, "www.agreed.com", 2, 3],
      [2, "second.com", 3, 2],
      [3, "poisoned.example", 1, 1],
    ]);
  });

  it("counts a site once per read and lists SERP features after the organic rows", async () => {
    const feature = { type: "people_also_ask", rank_absolute: 2 };
    mockReads({
      t1: completed(feature, organic(1, "a.com"), organic(2, "a.com")),
      t2: completed(organic(1, "a.com"), feature),
    });

    const result = await getSerpResultsTool.handler(args, toolContext);

    expect(
      itemsOf(result).map(({ type, rank, bestPosition, seenIn }) => [
        type,
        rank,
        bestPosition,
        seenIn,
      ]),
    ).toEqual([
      ["organic", 1, 1, 2],
      ["people_also_ask", null, null, 2],
    ]);
  });

  it("returns what each SERP feature shows, not only its type", async () => {
    mockReads({
      t1: completed(
        organic(1, "a.com"),
        {
          type: "people_also_ask",
          items: [{ title: "Turşu kaç günde olur?" }],
        },
        {
          type: "ai_overview",
          references: [
            { domain: "www.cimri.com", title: "Kavanozlar" },
            // Goto-wrapped sources say google.com; the name Google shows
            // tells the site instead, and google.com is never credited.
            {
              domain: "google.com",
              url: "https://google.com/goto?url=x",
              source: "dogaltursu.com",
              title: "Turşu Suyu Sümüksü Oldu",
            },
            {
              domain: "google.com",
              url: "https://google.com/goto?url=y",
              source: "YemekNet",
              title: "Turşu Suyu Neden Süner?",
            },
            {
              domain: "google.com",
              url: "https://google.com/goto?url=z",
              title: "Turşu tarifi",
            },
          ],
        },
        { type: "related_searches", items: ["lahana turşusu"] },
        { type: "compare_sites", items: [{ domain: "m.yelp.com" }] },
      ),
    });

    const result = await getSerpResultsTool.handler(args, toolContext);

    expect(itemsOf(result).map(({ type, details }) => [type, details])).toEqual(
      [
        ["organic", null],
        ["people_also_ask", ["Turşu kaç günde olur?"]],
        [
          "ai_overview",
          [
            "cimri.com: Kavanozlar",
            "dogaltursu.com: Turşu Suyu Sümüksü Oldu",
            "YemekNet: Turşu Suyu Neden Süner?",
            "Turşu tarifi",
          ],
        ],
        ["related_searches", ["lahana turşusu"]],
        ["compare_sites", ["m.yelp.com"]],
      ],
    );
    expect(textContent(result)).toContain("cimri.com: Kavanozlar");
  });

  it("reads to the requested depth and returns every merged site", async () => {
    const post = mockReads({
      t1: completed(organic(1, "a.com"), organic(2, "b.com")),
      t2: completed(organic(1, "c.com"), organic(2, "d.com")),
    });

    const result = await getSerpResultsTool.handler(
      { ...args, depth: 30 },
      toolContext,
    );

    expect(post).toHaveBeenCalledWith(expect.objectContaining({ depth: 30 }));
    expect(textContent(result)).toContain('"seo tools" (4 results)');
  });

  it("answers a repeat of a finished search from the cache instead of paying or polling again", async () => {
    const post = mockReads({ t1: completed(organic(1, "a.com")) });

    const first = await getSerpResultsTool.handler(args, toolContext);
    const repeat = await getSerpResultsTool.handler(args, toolContext);

    expect(post).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSerpTaskResult).toHaveBeenCalledTimes(1);
    expect(repeat.structuredContent).toEqual(first.structuredContent);
  });

  it("checks a still-running read once on a repeat instead of polling it", async () => {
    vi.useFakeTimers();
    mockReads({ t1: { status: "pending" } });
    await untilAnswered(getSerpResultsTool.handler(args, toolContext));
    const polls = mocks.fetchSerpTaskResult.mock.calls.length;

    // No fake time passes: a repeat that waited to poll again would hang.
    const repeat = await getSerpResultsTool.handler(args, toolContext);

    expect(textContent(repeat)).toContain("still running");
    expect(mocks.fetchSerpTaskResult).toHaveBeenCalledTimes(polls + 1);
  });

  it("reads the project's default device unless a query names one, each SERP separately", async () => {
    const post = mockReads({ t1: completed(organic(1, "a.com")) });

    await getSerpResultsTool.handler(args, toolContext);
    await getSerpResultsTool.handler(
      { ...args, queries: [{ keyword: "seo tools", device: "desktop" }] },
      toolContext,
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ device: "mobile" }),
    );
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ device: "desktop" }),
    );
  });

  it("starts a finalUrls search of its own without waiting on it, and a repeat collects it once every read is in", async () => {
    const reads: Record<string, object> = {
      t1: completed(organic(1, "a.com")),
      t2: completed(organic(1, "a.com")),
    };
    const post = mockReads(reads);
    // A finished default search must not answer for it: its URLs are wrapped.
    await getSerpResultsTool.handler(args, toolContext);
    const polls = mocks.fetchSerpTaskResult.mock.calls.length;
    const finalUrls = { ...args, finalUrls: true };

    const first = await getSerpResultsTool.handler(finalUrls, toolContext);
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ finalUrls: true }),
    );
    expect(textContent(first)).toContain("2-3 minutes");
    expect(mocks.fetchSerpTaskResult).toHaveBeenCalledTimes(polls);

    reads.t2 = { status: "pending" };
    const early = await getSerpResultsTool.handler(finalUrls, toolContext);
    expect(textContent(early)).toContain("2-3 minutes");

    reads.t2 = completed(organic(1, "a.com"));
    const repeat = await getSerpResultsTool.handler(finalUrls, toolContext);
    expect(post).toHaveBeenCalledTimes(2);
    expect(itemsOf(repeat)[0]).toMatchObject({ seenIn: 2 });
  });

  it("answers with the reads that are back, and a repeat merges in the late one", async () => {
    vi.useFakeTimers();
    const reads = {
      t1: completed(organic(1, "a.com")),
      t2: { status: "pending" } as object,
    };
    const post = mockReads(reads);

    const first = await untilAnswered(
      getSerpResultsTool.handler(args, toolContext),
    );
    expect(itemsOf(first)[0]).toMatchObject({ seenIn: 1 });

    reads.t2 = completed(organic(1, "a.com"));
    const repeat = await untilAnswered(
      getSerpResultsTool.handler(args, toolContext),
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(itemsOf(repeat)[0]).toMatchObject({ seenIn: 2 });
  });

  it("says to call again when no read is back, without charging for the repeat", async () => {
    vi.useFakeTimers();
    const reads: Record<string, object> = { t1: { status: "pending" } };
    const post = mockReads(reads);

    const first = await untilAnswered(
      getSerpResultsTool.handler(args, toolContext),
    );
    expect(textContent(first)).toContain("at no extra charge");

    reads.t1 = completed(organic(1, "a.com"));
    const repeat = await untilAnswered(
      getSerpResultsTool.handler(args, toolContext),
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(itemsOf(repeat)).toHaveLength(1);
  });

  it("buys fresh reads after every read failed or came back empty", async () => {
    const reads: Record<string, object> = {
      t1: { status: "failed", message: "Internal Error." },
    };
    const post = mockReads(reads);

    const failed = await getSerpResultsTool.handler(args, toolContext);
    expect(textContent(failed)).toContain("Internal Error.");

    reads.t1 = completed();
    const empty = await getSerpResultsTool.handler(args, toolContext);
    expect(textContent(empty)).toContain("(0 results)");

    reads.t1 = completed(organic(1, "a.com"));
    await getSerpResultsTool.handler(args, toolContext);

    expect(post).toHaveBeenCalledTimes(3);
  });
});
