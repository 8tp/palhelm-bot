import { describe, expect, it } from "vitest";
import { dexControlError, dexSectionFields } from "../src/commands/dex.js";
import type { PalKnowledge } from "../src/knowledge/paldeck.js";

const pal: PalKnowledge = {
  internalId: "Anubis",
  name: "Anubis",
  dexNumber: 100,
  isVariant: false,
  elements: ["Ground"],
  workSuitabilities: [
    { id: "Mining", name: "Mining", level: 3 },
    { id: "Handiwork", name: "Handiwork", level: 4 },
  ],
  learnset: [{ id: "StoneBlast", name: "Stone Blast", unlockLevel: 1, element: "Ground", power: 55, cooldownSeconds: 10, hasSkillFruit: true, inheritable: true }],
  guaranteedPassives: [{ id: "EarthEmperor", name: "Earth Emperor", rank: 3, inheritable: true }],
  hp: 120,
  attack: 130,
  defense: 100,
  rarity: 8,
  breedingPower: 570,
  minWildLevel: 20,
  maxWildLevel: 47,
  size: "M",
  nocturnal: false,
  walkSpeed: 80,
  runSpeed: 800,
  rideSprintSpeed: 1000,
  transportSpeed: 480,
  stamina: 100,
  foodAmount: 6,
  maxFullStomach: 475,
  price: 31_250,
};

describe("dex interactive sections", () => {
  it("keeps section payloads focused and complete", () => {
    expect(dexSectionFields(pal, "overview").map((field) => field.name)).toEqual(["Elements", "Base scaling", "Breeding", "Wild profile"]);
    expect(dexSectionFields(pal, "work")[0]?.value).toBe("Handiwork 4 · Mining 3");
    expect(dexSectionFields(pal, "combat").find((field) => field.name === "Active-skill learnset")?.value).toContain("Stone Blast");
    expect(dexSectionFields(pal, "breeding").find((field) => field.name === "Dataset coverage")).toBeDefined();
  });

  it("accepts only the requester using the live control and a known section", () => {
    const expected = "dex_section:interaction-1";
    expect(dexControlError(expected, expected, "requester", "requester", "combat")).toBeNull();
    expect(dexControlError(expected, "dex_section:old", "requester", "requester", "combat")).toContain("no longer valid");
    expect(dexControlError(expected, expected, "requester", "someone-else", "combat")).toContain("Only the person");
    expect(dexControlError(expected, expected, "requester", "requester", "deleted-section")).toContain("section is no longer valid");
  });
});
