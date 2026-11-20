import { describe, expect, it } from "vitest";
import { lowercaseKeyword } from "./text-match";

describe("lowercaseKeyword", () => {
  it.each([
    ["tr", "KIRMIZI", "kırmızı"],
    ["tr", "İstanbul", "istanbul"],
    ["tr-TR", "ISPARTA", "ısparta"],
    ["az", "İLHAM IŞIQ", "ilham ışıq"],
    ["en", "TITLE", "title"],
    ["en", "İzmir", "izmir"],
    // "İ" written as I plus a combining dot (NFD).
    ["tr", "I\u0307stanbul", "istanbul"],
    ["en", "I\u0307stanbul", "istanbul"],
    // Already lower-cased the old way: i plus a stray combining dot.
    ["en", "i\u0307stanbul", "istanbul"],
  ])("%s: %s → %s", (languageCode, text, expected) => {
    expect(lowercaseKeyword(text, languageCode)).toBe(expected);
  });
});
