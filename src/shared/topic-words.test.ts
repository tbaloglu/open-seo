import { describe, expect, it } from "vitest";
import { splitTopicWords, topicWordsSchema } from "./topic-words";

describe("topic words", () => {
  it("splits a field the way the topic filter reads it", () => {
    expect(splitTopicWords(" turşu, ,TURŞU + kavanoz,")).toEqual([
      "turşu",
      "kavanoz",
    ]);
  });

  // Every writer (app, settings page, MCP) shares these limits.
  it("accepts 50 words of up to 40 characters and nothing more", () => {
    const words = Array.from({ length: 50 }, () => "a".repeat(40));
    expect(topicWordsSchema.safeParse(words).success).toBe(true);
    expect(topicWordsSchema.safeParse([...words, "b"]).success).toBe(false);
    expect(topicWordsSchema.safeParse(["a".repeat(41)]).success).toBe(false);
    expect(topicWordsSchema.safeParse(["   "]).success).toBe(false);
  });
});
