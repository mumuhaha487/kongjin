import { describe, expect, it } from "vitest";
import { structuralShare } from "../src/lib/structural-share";

describe("narrow settings publication", () => {
  it("retains unrelated branches and updates only the changed row value", () => {
    const original = {
      settings: { history: true, seconds: false },
      profile: { nickname: "空境" },
      groups: [{ id: "a" }],
    };
    const next = structuredClone(original);
    next.settings.history = false;
    const result = structuralShare(original, next);
    expect(result.settings.history).toBe(false);
    expect(result.settings).not.toBe(original.settings);
    expect(result.profile).toBe(original.profile);
    expect(result.groups).toBe(original.groups);
    expect(original.settings.history).toBe(true);
  });
  it("publishes additions and deletions, including array items", () => {
    const previous = { a: [{ id: 1 }, { id: 2 }], b: "retained" };
    const next = { a: [{ id: 1 }], b: "retained" };
    const result = structuralShare(previous, next);
    expect(result.a).toHaveLength(1);
    expect(result.a[0]).toBe(previous.a[0]);
    expect(structuralShare({ a: 1 }, { a: 1, b: 2 } as { a: number })).toEqual({
      a: 1,
      b: 2,
    });
  });
});
