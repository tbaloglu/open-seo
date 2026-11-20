import { describe, expect, it } from "vitest";
import { planDailyFetches, planMonthlyFetches } from "./archivePlan";

const period = (
  month: string,
  fetchedThrough: string,
  fetchedAt: string,
  complete = false,
) => ({ month, fetchedThrough, fetchedAt, complete });

describe("monthly query × page plan", () => {
  it("writes a month only once it ended 4 days ago, and rewrites the latest such month", () => {
    // October ended 3 days before Nov 4: not complete yet.
    expect(
      planMonthlyFetches({
        mode: "incremental",
        today: "2026-11-03",
        periods: [period("2026-09", "2026-09-30", "2026-10-05", true)],
      }).map((fetch) => fetch.month),
    ).toEqual(["2026-09"]);

    expect(
      planMonthlyFetches({
        mode: "incremental",
        today: "2026-11-04",
        periods: [
          period("2026-09", "2026-09-30", "2026-10-05", true),
          period("2026-10", "2026-10-31", "2026-11-04", true),
        ],
      }).map((fetch) => fetch.month),
    ).toEqual(["2026-10"]);
  });

  it("backfills every whole month Google still has, oldest first", () => {
    const months = planMonthlyFetches({
      mode: "backfill",
      today: "2026-11-20",
      periods: [],
    }).map((fetch) => fetch.month);
    // The floor is 2025-07-20, so July 2025 is partial and left out.
    expect(months[0]).toBe("2025-08");
    expect(months.at(-1)).toBe("2026-10");
    expect(months).toHaveLength(15);
  });
});

describe("daily plan", () => {
  it("re-reads the days that were still fresh when last fetched", () => {
    const [fetch] = planDailyFetches({
      source: "gsc_page",
      mode: "incremental",
      today: "2026-11-20",
      periods: [
        period("2026-09", "2026-09-30", "2026-10-10T00:00:00Z", true),
        period("2026-10", "2026-10-31", "2026-11-10T00:00:00Z", true),
        // Fetched on the 15th through the 14th: days after the 11th may
        // still have changed.
        period("2026-11", "2026-11-14", "2026-11-15T00:00:00Z"),
      ],
    });
    expect(fetch).toEqual({
      source: "gsc_page",
      month: "2026-11",
      startDate: "2026-11-12",
      endDate: "2026-11-19",
      complete: false,
    });
  });

  it("marks a month complete only when all of it is older than 4 days", () => {
    const fetches = planDailyFetches({
      source: "gsc_site",
      mode: "incremental",
      today: "2026-11-03",
      periods: [period("2026-09", "2026-09-30", "2026-10-05", true)],
    });
    expect(fetches.map(({ month, complete }) => ({ month, complete }))).toEqual(
      [
        { month: "2026-10", complete: false },
        { month: "2026-11", complete: false },
      ],
    );
    expect(
      planDailyFetches({
        source: "gsc_site",
        mode: "incremental",
        today: "2026-11-04",
        periods: [period("2026-09", "2026-09-30", "2026-10-05", true)],
      })[0],
    ).toMatchObject({ month: "2026-10", complete: true });
  });

  it("resumes a backfill without fetching complete months again", () => {
    const fetches = planDailyFetches({
      source: "ga4_site",
      mode: "backfill",
      today: "2026-11-20",
      periods: [
        period("2025-07", "2025-07-31", "2026-11-19", true),
        period("2025-08", "2025-08-31", "2026-11-19", true),
      ],
    });
    expect(fetches[0]).toMatchObject({
      month: "2025-09",
      startDate: "2025-09-01",
    });
    expect(fetches.at(-1)).toMatchObject({
      month: "2026-11",
      endDate: "2026-11-19",
    });
  });
});
