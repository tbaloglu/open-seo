import { describe, expect, it } from "vitest";
import {
  planLegacyTopicUpload,
  syncTopicField,
  topicDraftState,
} from "./topicWordsDraft";

describe("syncTopicField", () => {
  it("fills the field from the first load", () => {
    expect(
      syncTopicField({ current: "", synced: null, saved: ["turşu", "jar"] }),
    ).toEqual({ fieldText: "turşu, jar", synced: "turşu, jar" });
  });

  it("follows a newer list while the field is unedited", () => {
    expect(
      syncTopicField({ current: "turşu", synced: "turşu", saved: ["brine"] }),
    ).toEqual({ fieldText: "brine", synced: "brine" });
  });

  // An agent or another tab changed the list while the user was editing: the
  // user's text stays, and nothing is written.
  it("keeps an edited field when the list changes", () => {
    expect(
      syncTopicField({
        current: "turşu, kavanoz",
        synced: "turşu",
        saved: ["brine"],
      }),
    ).toEqual({ fieldText: null, synced: "turşu" });
  });

  // Clear all / Clear filters empty the field for this view only.
  it("keeps a locally cleared field empty when the list refetches", () => {
    const next = syncTopicField({
      current: "",
      synced: "turşu",
      saved: ["turşu"],
    });
    expect(next.fieldText).toBeNull();
    expect(topicDraftState("", ["turşu"]).differs).toBe(true);
  });

  it("takes a saved edit as the new baseline", () => {
    expect(
      syncTopicField({
        current: "Turşu , kavanoz",
        synced: "turşu",
        saved: ["Turşu", "kavanoz"],
      }),
    ).toEqual({ fieldText: null, synced: "Turşu , kavanoz" });
  });
});

describe("topicDraftState", () => {
  it("offers save only for a valid list that differs from the saved one", () => {
    expect(topicDraftState("turşu, jar", ["turşu", "jar"]).canSave).toBe(false);
    expect(topicDraftState("turşu, brine", ["turşu"]).canSave).toBe(true);
    expect(topicDraftState("a".repeat(41), []).canSave).toBe(false);
  });

  it("compares word by word, not as joined text", () => {
    expect(topicDraftState("a, b", ["a\nb"]).differs).toBe(true);
  });
});

describe("planLegacyTopicUpload", () => {
  it("uploads only to a project with no saved words, dropping invalid ones", () => {
    expect(
      planLegacyTopicUpload(`turşu, ${"a".repeat(41)}, TURŞU`, []),
    ).toEqual({ kind: "upload", words: ["turşu"] });
    expect(planLegacyTopicUpload("turşu", ["brine"])).toEqual({
      kind: "clear",
    });
    expect(planLegacyTopicUpload("a".repeat(41), [])).toEqual({
      kind: "clear",
    });
    expect(planLegacyTopicUpload("", [])).toEqual({ kind: "none" });
  });
});
