import { describe, expect, it } from "vitest";
import { syncTopicField, topicDraftState } from "./topicWordsDraft";

const synced = (text: string, words: string[]) => ({ text, words });

describe("syncTopicField", () => {
  it("fills the field from the first load", () => {
    expect(
      syncTopicField({ current: "", baseline: null, saved: ["turşu", "jar"] }),
    ).toEqual({
      fieldText: "turşu, jar",
      baseline: synced("turşu, jar", ["turşu", "jar"]),
    });
  });

  it("follows a newer list while the field is unedited", () => {
    expect(
      syncTopicField({
        current: "turşu",
        baseline: synced("turşu", ["turşu"]),
        saved: ["brine"],
      }).fieldText,
    ).toBe("brine");
  });

  // An agent or another tab changed the list while the user was editing: the
  // user's text stays, nothing is written, and the page says a save replaces
  // the other change.
  it("keeps an edited field when the list changes elsewhere", () => {
    const baseline = synced("turşu", ["turşu"]);
    const next = syncTopicField({
      current: "turşu, kavanoz",
      baseline,
      saved: ["brine"],
    });
    expect(next).toEqual({ fieldText: null, baseline });
    expect(
      topicDraftState("turşu, kavanoz", ["brine"], next.baseline)
        .changedElsewhere,
    ).toBe(true);
  });

  // Clear all / Clear filters empty the field for this view only.
  it("keeps a locally cleared field empty when the list refetches", () => {
    const next = syncTopicField({
      current: "",
      baseline: synced("turşu", ["turşu"]),
      saved: ["turşu"],
    });
    expect(next.fieldText).toBeNull();
    const draft = topicDraftState("", ["turşu"], next.baseline);
    expect(draft.differs).toBe(true);
    expect(draft.changedElsewhere).toBe(false);
  });

  it("takes a saved edit as the new baseline", () => {
    expect(
      syncTopicField({
        current: "Turşu , kavanoz",
        baseline: synced("turşu", ["turşu"]),
        saved: ["Turşu", "kavanoz"],
      }),
    ).toEqual({
      fieldText: null,
      baseline: synced("Turşu , kavanoz", ["Turşu", "kavanoz"]),
    });
  });
});

describe("topicDraftState", () => {
  it("offers save only for a valid list that differs from the saved one", () => {
    const state = (text: string, saved: string[]) =>
      topicDraftState(text, saved, null).canSave;
    expect(state("turşu, jar", ["turşu", "jar"])).toBe(false);
    expect(state("turşu, brine", ["turşu"])).toBe(true);
    expect(state("a".repeat(41), [])).toBe(false);
  });

  it("compares word by word, not as joined text", () => {
    expect(topicDraftState("a, b", ["a\nb"], null).differs).toBe(true);
  });
});
