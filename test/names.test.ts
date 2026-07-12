import { describe, expect, it } from "vitest";
import { humanizeInternalName, looksLikeInternalId, resolvePalDisplayName } from "../src/pals/names.js";

const catalogue: Record<string, { name: string }> = {
  pinkrabbit_grass: { name: "Ribbuny Botan" },
  kitsunebi_ice: { name: "Foxparks Cryst" },
  anubis: { name: "Anubis" },
};
const lookup = (baseId: string) => catalogue[baseId.toLowerCase()] ?? null;

describe("looksLikeInternalId", () => {
  it("flags raw identifiers but accepts localized names", () => {
    expect(looksLikeInternalId("PinkRabbit_Grass")).toBe(true);
    expect(looksLikeInternalId("BOSS_Kitsunebi_Ice")).toBe(true);
    expect(looksLikeInternalId("Female_People03")).toBe(true);
    expect(looksLikeInternalId("Ribbuny Botan")).toBe(false);
    expect(looksLikeInternalId("Anubis")).toBe(false);
  });
});

describe("humanizeInternalName", () => {
  it("turns human NPC identifiers into readable labels", () => {
    expect(humanizeInternalName("BOSS_Female_People03")).toBe("Human (Female)");
    expect(humanizeInternalName("BOSS_Male_People01")).toBe("Human (Male)");
    expect(humanizeInternalName("BOSS_Hunter_Rifle")).toBe("Hunter Rifle");
    expect(humanizeInternalName("BOSS_SecurityDrone")).toBe("Security Drone");
  });
});

describe("resolvePalDisplayName", () => {
  it("prefers the pinned name when the panel returned a raw identifier", () => {
    expect(resolvePalDisplayName("PinkRabbit_Grass", "PinkRabbit_Grass", lookup)).toBe("Ribbuny Botan");
    expect(resolvePalDisplayName("BOSS_Kitsunebi_Ice", "Kitsunebi_Ice", lookup)).toBe("Foxparks Cryst");
  });

  it("humanizes human NPC bosses that have no pinned entry", () => {
    expect(resolvePalDisplayName("BOSS_Female_People03", "Female_People03", lookup)).toBe("Human (Female)");
    expect(resolvePalDisplayName("BOSS_Hunter_Rifle", "Hunter_Rifle", lookup)).toBe("Hunter Rifle");
  });

  it("leaves already-friendly names untouched", () => {
    expect(resolvePalDisplayName("Anubis", "Anubis", lookup)).toBe("Anubis");
    expect(resolvePalDisplayName("SheepBall", "Lamball", () => null)).toBe("Lamball");
  });

  it("does not let a friendly-looking placeholder override a canonical ID", () => {
    expect(resolvePalDisplayName("Anubis", "Aerodeus", lookup)).toBe("Anubis");
  });
});
