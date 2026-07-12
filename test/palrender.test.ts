import { describe, expect, it } from "vitest";
import {
  boxPageCount,
  computeGridPlacements,
} from "../src/discord/palrender.js";
import type { Pal } from "../src/types.js";

function pal(boxPage?: number | null): Pal {
  return {
    instanceId: crypto.randomUUID(),
    characterId: "SheepBall",
    displayName: "Lamball",
    level: 1,
    isAlpha: false,
    isLucky: false,
    boxPage,
  };
}

describe("pal grid placement", () => {
  it("packs sequential items by row", () => {
    expect(computeGridPlacements(4, { cols: 3 })).toEqual([
      { itemIndex: 0, slot: 0, col: 0, row: 0 },
      { itemIndex: 1, slot: 1, col: 1, row: 0 },
      { itemIndex: 2, slot: 2, col: 2, row: 0 },
      { itemIndex: 3, slot: 3, col: 0, row: 1 },
    ]);
  });

  it("preserves explicit box gaps and rejects out-of-grid slots", () => {
    expect(computeGridPlacements(4, {
      cols: 6,
      rows: 5,
      slots: [0, 8, null, 30],
    })).toEqual([
      { itemIndex: 0, slot: 0, col: 0, row: 0 },
      { itemIndex: 1, slot: 8, col: 2, row: 1 },
    ]);
  });
});

describe("box page count", () => {
  it("uses the highest zero-based page and ignores absent placements", () => {
    expect(boxPageCount([pal(undefined), pal(null), pal(0), pal(3)])).toBe(4);
    expect(boxPageCount([pal(undefined), pal(null)])).toBe(0);
  });
});
