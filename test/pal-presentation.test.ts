import { describe, expect, it } from "vitest";
import { baseCharacterId, isBossVariant, palVariantTags } from "../src/pals/presentation.js";

describe("Pal boss presentation", () => {
  it("normalizes boss IDs without losing the variant signal", () => {
    const pal = { characterId: "BOSS_GrassMammoth", isAlpha: true, isLucky: false };
    expect(baseCharacterId(pal.characterId)).toBe("GrassMammoth");
    expect(isBossVariant(pal)).toBe(true);
    expect(palVariantTags(pal)).toBe(" 👑");
  });

  it("keeps ordinary Alpha and Lucky marks distinct", () => {
    expect(palVariantTags({ characterId: "GrassMammoth", isAlpha: true, isLucky: true }))
      .toBe(" ⭐ 🍀");
  });
});
