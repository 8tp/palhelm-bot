import { describe, expect, it } from "vitest";
import { findOwnedBreedingMatch } from "../src/breeding/owned.js";
import type { RosterPal } from "../src/types.js";

const pal = (instanceId: string, gender?: RosterPal["gender"]): RosterPal => ({
  instanceId, characterId: "Anubis", displayName: "Anubis", level: 20,
  isAlpha: false, isLucky: false, ownerUid: "u", ownerName: "Player", gender,
});

describe("owned breeding gender checks", () => {
  it("requires distinct opposite-gender instances for wildcard pairs", () => {
    expect(findOwnedBreedingMatch(
      { parent1Gender: "WILDCARD", parent2Gender: "WILDCARD" },
      [pal("m", "male")], [pal("f", "female")],
    )).toMatchObject({ compatible: true, first: { instanceId: "m" }, second: { instanceId: "f" } });
    expect(findOwnedBreedingMatch(
      { parent1Gender: "WILDCARD", parent2Gender: "WILDCARD" },
      [pal("m1", "male"), pal("m2", "male")], [pal("m1", "male"), pal("m2", "male")],
    )).toMatchObject({ compatible: false, reason: "same_gender_only" });
  });

  it("honors fixed parent genders and does not treat unknown as compatible", () => {
    expect(findOwnedBreedingMatch(
      { parent1Gender: "FEMALE", parent2Gender: "MALE" },
      [pal("f", "female")], [pal("m", "male")],
    ).compatible).toBe(true);
    expect(findOwnedBreedingMatch(
      { parent1Gender: "FEMALE", parent2Gender: "MALE" },
      [pal("m1", "male")], [pal("m2", "male")],
    )).toMatchObject({ compatible: false, reason: "fixed_gender_missing" });
    expect(findOwnedBreedingMatch(
      { parent1Gender: "WILDCARD", parent2Gender: "WILDCARD" },
      [pal("x")], [pal("f", "female")],
    )).toMatchObject({ compatible: false, reason: "gender_unknown" });
  });
});
