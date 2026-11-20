import { describe, expect, it } from "vitest";
import { resolveRunPair } from "./serpRunPickers";

// Newest first, the oldest from before SERP history was saved.
const runs = [
  { id: "mar3", saved: true },
  { id: "mar2", saved: true },
  { id: "mar1", saved: false },
];

describe("resolveRunPair", () => {
  it("never offers the oldest saved check as the later one", () => {
    const pair = resolveRunPair(runs, { toId: "mar2" });

    expect(pair?.laterOptions.map((run) => run.id)).toEqual(["mar3"]);
    expect(pair).toMatchObject({ toId: "mar3", fromId: "mar2" });
  });

  it("moves the earlier check when the later one passes it", () => {
    const more = [{ id: "mar4", saved: true }, ...runs];

    expect(
      resolveRunPair(more, { toId: "mar3", fromId: "mar4" }),
    ).toMatchObject({ toId: "mar3", fromId: "mar2" });
  });

  it("is null with fewer than two saved checks", () => {
    expect(resolveRunPair(runs.slice(1), {})).toBeNull();
  });
});
