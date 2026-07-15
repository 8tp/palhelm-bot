import { describe, expect, it } from "vitest";
import { instanceFields, placementLabel } from "../src/commands/pal.js";
import type { PalKnowledge } from "../src/knowledge/paldeck.js";
import type { RosterPal } from "../src/types.js";

const pal = {
  instanceId: "p1", characterId: "Anubis", displayName: "Anubis", level: 35,
  isAlpha: false, isLucky: false, ownerUid: "u1", ownerName: "Player One",
  inParty: true, partySlot: 1,
} satisfies RosterPal;

const known = {
  internalId: "Anubis", name: "Anubis", dexNumber: 1, isVariant: false,
  elements: ["Ground"], workSuitabilities: [{ id: "Mining", name: "Mining", level: 4 }],
  learnset: [{ id: "Rock", name: "Rock Burst", unlockLevel: 20, element: "Ground", power: 80, cooldownSeconds: 10, hasSkillFruit: false, inheritable: true }],
  guaranteedPassives: [], hp: 100, attack: 120, defense: 90, rarity: 5, breedingPower: 100,
  minWildLevel: 1, maxWildLevel: 50, size: "M", nocturnal: false, walkSpeed: 1, runSpeed: 1,
  rideSprintSpeed: 1, transportSpeed: 1, stamina: 1, foodAmount: 1, maxFullStomach: 1, price: 1,
} satisfies PalKnowledge;

describe("/pal detail", () => {
  it("labels species knowledge separately from unavailable individual save data", () => {
    const fields = instanceFields(pal, known, "Player One");
    expect(fields.find((field) => field.name.startsWith("Work suitability"))?.value).toContain("Mining **Lv 4**");
    expect(fields.find((field) => field.name.startsWith("Learnset"))?.name).toContain("not equipped skills");
    expect(fields.find((field) => field.name === "Individual save data")?.value).toContain("unavailable for this Pal");
  });

  it("renders rich individual values only when the panel supplies them", () => {
    const fields = instanceFields({
      ...pal, hp: 1234, gender: "male", talents: { hp: 75, melee: 50, shot: 90, defense: 60 },
      passiveSkillIds: ["Legend"], equippedSkillIds: ["RockLance"],
    }, known, "Player One");
    const detail = fields.find((field) => field.name === "Individual save data")?.value;
    expect(detail).toContain("Current HP: 1234");
    expect(detail).toContain("Passives: Legend");
    expect(detail).toContain("Equipped: Rock Lance");
  });

  it("does not expose save or base identifiers in player-facing placement text", () => {
    const baseWorker = {
      ...pal,
      inParty: false,
      partySlot: null,
      placement: "base" as const,
      baseId: "0123456789abcdef0123456789abcdef",
    };
    expect(placementLabel(baseWorker)).toBe("Base worker");
    expect(placementLabel(baseWorker)).not.toContain(baseWorker.baseId);
  });
});
