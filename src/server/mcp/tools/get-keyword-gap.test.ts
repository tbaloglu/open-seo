import { beforeEach, describe, expect, it, vi } from "vitest";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import { getKeywordGapTool } from "./get-keyword-gap";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  hasGoogleOAuthConfig: vi.fn(),
  getPerformance: vi.fn(),
  rankedKeywords: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn().mockResolvedValue("key"),
  getCached: vi.fn().mockResolvedValue(null),
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
  createDataforseoClient: () => ({
    domain: { rankedKeywords: mocks.rankedKeywords },
  }),
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

const run = () =>
  getKeywordGapTool.handler(
    { projectId: "project_1", competitorDomain: "rakip.com" },
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

  it("pages through Search Console until a short page", async () => {
    const fullPage = Array.from({ length: 25_000 }, (_, index) =>
      gscRow(`sorgu ${index}`, 4, 1),
    );
    mocks.getPerformance
      .mockResolvedValueOnce(gscPage(fullPage))
      .mockResolvedValueOnce(gscPage([gscRow("izmir turşu", 4)]));
    mocks.rankedKeywords.mockResolvedValue({
      items: [competitorRow("İzmir turşu", 500)],
      totalCount: 1,
    });

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
    expect(mocks.getPerformance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ rowLimit: 25_000, startRow: 25_000 }),
    );
    expect(result.structuredContent).toMatchObject({
      counts: { matched: 1, gap: 0 },
      searchConsoleTruncated: false,
    });
  });

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
