import { beforeEach, describe, expect, it, vi } from "vitest";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import { getKeywordGapTool } from "./get-keyword-gap";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  hasGoogleOAuthConfig: vi.fn(),
  getPerformance: vi.fn(),
  rankedKeywords: vi.fn(),
  createDataforseoClient: vi.fn(),
  buildCacheKey: vi.fn(),
  getCached: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: mocks.buildCacheKey,
  getCached: mocks.getCached,
  setCached: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/features/google/oauth-config", () => ({
  hasGoogleOAuthConfig: mocks.hasGoogleOAuthConfig,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

const toolContext = makeToolContext();

const competitorRow = (keyword: string, volume: number, rank = 3) => ({
  keyword_data: { keyword, keyword_info: { search_volume: volume } },
  ranked_serp_element: {
    serp_item: { rank_absolute: rank, url: `https://rakip.com/${volume}` },
  },
});

const gscRow = (query: string, position: number, impressions = 100) => ({
  keys: [query],
  clicks: 2,
  impressions,
  ctr: 0.02,
  position,
});

function gscPage(rows: ReturnType<typeof gscRow>[]) {
  return {
    siteUrl: "sc-domain:biz.com",
    connectedBy: null,
    request: { startDate: "2026-08-17", endDate: "2026-11-17" },
    rows,
  };
}

const fullGscPage = () =>
  gscPage(
    Array.from({ length: 25_000 }, (_, index) => gscRow(`sorgu ${index}`, 4)),
  );

function setUp(keywords: string[], ours: ReturnType<typeof gscRow>[]) {
  mocks.rankedKeywords.mockResolvedValue({
    items: keywords.map((keyword, index) =>
      competitorRow(keyword, 900 - index),
    ),
    totalCount: keywords.length,
  });
  mocks.getPerformance.mockResolvedValue(gscPage(ours));
}

const run = (competitorDomain = "rakip.com") =>
  getKeywordGapTool.handler(
    { projectId: "project_1", competitorDomain },
    toolContext,
  );

describe("get_keyword_gap", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2792,
      languageCode: "tr",
    });
    mocks.hasGoogleOAuthConfig.mockResolvedValue(true);
    mocks.getPerformance.mockResolvedValue(gscPage([]));
    mocks.rankedKeywords.mockResolvedValue({ items: [], totalCount: 0 });
    mocks.createDataforseoClient.mockReturnValue({
      domain: { rankedKeywords: mocks.rankedKeywords },
    });
    mocks.buildCacheKey.mockResolvedValue("key");
    mocks.getCached.mockResolvedValue(null);
  });

  it("matches Turkish queries after folding and keeps weak and missing ones as gaps", async () => {
    mocks.rankedKeywords.mockResolvedValue({
      items: [
        competitorRow("İzmir Turşu", 500),
        competitorRow("ISPARTA  gül", 300),
        competitorRow("şeker turşusu", 1000),
      ],
      totalCount: 3,
    });
    mocks.getPerformance.mockResolvedValue(
      gscPage([
        gscRow("izmir turşu", 5),
        gscRow("ısparta gül", 35),
        // Only i-letters fold: "seker" is not "şeker".
        gscRow("seker turşusu", 2),
      ]),
    );

    const result = await run();

    expect(result.structuredContent).toMatchObject({
      ok: true,
      counts: { competitorTotal: 3, matched: 2, gap: 2 },
      keywords: [
        { keyword: "şeker turşusu", ourPosition: null, ourImpressions: null },
        { keyword: "ISPARTA  gül", ourPosition: 35, ourImpressions: 100 },
      ],
    });
    expect(mocks.rankedKeywords).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "rakip.com",
        locationCode: 2792,
        languageCode: "tr",
        limit: 1000,
        filters: [["ranked_serp_element.serp_item.rank_absolute", "<=", 30]],
      }),
    );
  });

  it("matches a precomposed letter against its decomposed form", async () => {
    setUp(["şeker"], [gscRow("şeker", 3)]);

    const result = await run();

    expect(result.structuredContent).toMatchObject({
      counts: { matched: 1, gap: 0 },
    });
  });

  it("weights our position by impressions across folded variants", async () => {
    setUp(
      ["izmir turşu"],
      [gscRow("İzmir turşu", 10, 100), gscRow("izmir  turşu", 40, 300)],
    );

    const result = await run();

    expect(result.structuredContent).toMatchObject({
      counts: { matched: 1, gap: 1 },
      keywords: [{ ourPosition: 32.5, ourImpressions: 400, ourClicks: 4 }],
    });
  });

  it("counts a position equal to the threshold as ranking", async () => {
    setUp(
      ["tam esik", "biraz kotu"],
      [gscRow("tam esik", 20), gscRow("biraz kotu", 20.1)],
    );

    const result = await run();

    expect(result.structuredContent).toMatchObject({
      counts: { matched: 2, gap: 1 },
      keywords: [{ keyword: "biraz kotu", ourPosition: 20.1 }],
    });
  });

  it("pages through Search Console on page 0's dates until a short page", async () => {
    setUp(["İzmir turşu"], []);
    mocks.getPerformance
      .mockResolvedValueOnce(fullGscPage())
      .mockResolvedValueOnce(gscPage([gscRow("izmir turşu", 4)]));

    const result = await run();

    expect(mocks.getPerformance).toHaveBeenCalledTimes(2);
    expect(mocks.getPerformance).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        dateRange: "last_3_months",
        rowLimit: 25_000,
        startRow: 0,
      }),
    );
    expect(mocks.getPerformance).toHaveBeenNthCalledWith(2, {
      projectId: "project_1",
      dimensions: ["query"],
      startDate: "2026-08-17",
      endDate: "2026-11-17",
      rowLimit: 25_000,
      startRow: 25_000,
      type: "web",
    });
    expect(result.structuredContent).toMatchObject({
      counts: { matched: 1, gap: 0 },
      searchConsoleTruncated: false,
    });
  });

  it("stops after four full Search Console pages and reports truncation", async () => {
    mocks.getPerformance.mockImplementation(() =>
      Promise.resolve(fullGscPage()),
    );

    const result = await run();

    expect(mocks.getPerformance).toHaveBeenCalledTimes(4);
    expect(result.structuredContent).toMatchObject({
      searchConsoleTruncated: true,
    });
  });

  it("bills the project and caches per tenant, normalized domain and request", async () => {
    await run("https://www.Rakip.com/");

    expect(mocks.createDataforseoClient).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_123",
        projectId: "project_1",
      }),
    );
    expect(mocks.buildCacheKey).toHaveBeenCalledWith("keyword-gap:competitor", {
      organizationId: "org_123",
      projectId: "project_1",
      domain: "rakip.com",
      scope: "subdomains",
      path: "",
      locationCode: 2792,
      languageCode: "tr",
      maxRank: 30,
      limit: 1000,
    });
  });

  it("serves a cached competitor read without calling DataForSEO", async () => {
    mocks.getCached.mockResolvedValue({
      keywords: [
        {
          keyword: "turşu",
          searchVolume: 100,
          rank: 2,
          url: null,
          intent: null,
        },
      ],
      totalCount: 1,
    });

    const result = await run();

    expect(mocks.rankedKeywords).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      counts: { competitorTotal: 1, gap: 1 },
    });
  });

  it.each(["rakip.com/blog", "ftp://rakip.com", "com.tr", "not a domain"])(
    "rejects competitor %s before reading anything",
    async (competitorDomain) => {
      await expect(run(competitorDomain)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(mocks.getPerformance).not.toHaveBeenCalled();
      expect(mocks.rankedKeywords).not.toHaveBeenCalled();
    },
  );

  it("charges nothing when Search Console is not connected", async () => {
    mocks.getPerformance.mockRejectedValue(
      new GscNotConnectedError("project_1"),
    );

    const result = await run();

    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
    expect(mocks.rankedKeywords).not.toHaveBeenCalled();
  });

  it("rejects a project outside the caller's organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);

    await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.getProjectForOrganization).toHaveBeenCalledWith(
      "org_123",
      "project_1",
    );
    expect(mocks.getPerformance).not.toHaveBeenCalled();
    expect(mocks.rankedKeywords).not.toHaveBeenCalled();
  });
});
