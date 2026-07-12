import { describe, expect, it } from "vitest";
import { breedControlError, breedNavigationRow, breedPageRange } from "../src/commands/breed.js";

describe("breed pagination controls", () => {
  it("paginates six combinations at a time and clamps boundaries", () => {
    expect(breedPageRange(13, 1)).toEqual({ page: 1, pageCount: 3, start: 0, end: 6 });
    expect(breedPageRange(13, 2)).toEqual({ page: 2, pageCount: 3, start: 6, end: 12 });
    expect(breedPageRange(13, 99)).toEqual({ page: 3, pageCount: 3, start: 12, end: 13 });
    expect(breedPageRange(1, -4)).toEqual({ page: 1, pageCount: 1, start: 0, end: 1 });
  });

  it("accepts only live previous/next controls from the requester", () => {
    const ids = { previous: "breed_prev:interaction-1", next: "breed_next:interaction-1" };
    expect(breedControlError(ids, ids.next, "requester", "requester")).toBeNull();
    expect(breedControlError(ids, "breed_next:old", "requester", "requester")).toContain("no longer valid");
    expect(breedControlError(ids, ids.previous, "requester", "someone-else")).toContain("Only the person");
    expect(breedControlError(ids, "breed_page:interaction-1", "requester", "requester")).toContain("no longer valid");
  });

  it("disables page boundaries and all expired controls", () => {
    const first = breedNavigationRow("i1", 1, 3).toJSON().components;
    expect(first.map((button) => button.disabled)).toEqual([true, true, false]);
    const last = breedNavigationRow("i1", 3, 3).toJSON().components;
    expect(last.map((button) => button.disabled)).toEqual([false, true, true]);
    const expired = breedNavigationRow("i1", 2, 3, true).toJSON().components;
    expect(expired.every((button) => button.disabled)).toBe(true);
  });
});
