import type { BreedingOutcome, PalGender } from "../knowledge/paldeck.js";
import type { RosterPal } from "../types.js";

export interface OwnedBreedingMatch {
  compatible: boolean;
  first: RosterPal | null;
  second: RosterPal | null;
  firstEligible: number;
  secondEligible: number;
  unknownGender: number;
  reason: "ready" | "missing_parent" | "same_gender_only" | "gender_unknown" | "fixed_gender_missing";
}

/** Palworld breeding requires two distinct, opposite-gender instances. */
export function findOwnedBreedingMatch(
  outcome: Pick<BreedingOutcome, "parent1Gender" | "parent2Gender">,
  first: readonly RosterPal[],
  second: readonly RosterPal[],
): OwnedBreedingMatch {
  const firstEligible = first.filter((pal) => genderMatches(pal.gender, outcome.parent1Gender));
  const secondEligible = second.filter((pal) => genderMatches(pal.gender, outcome.parent2Gender));
  for (const a of firstEligible) {
    for (const b of secondEligible) {
      if (a.instanceId === b.instanceId) continue;
      if (a.gender === b.gender) continue;
      return {
        compatible: true, first: a, second: b,
        firstEligible: firstEligible.length, secondEligible: secondEligible.length,
        unknownGender: unknownCount(first) + unknownCount(second), reason: "ready",
      };
    }
  }
  const unknownGender = unknownCount(first) + unknownCount(second);
  const bothSpeciesPresent = first.length > 0 && second.length > 0;
  const fixedMissing =
    (isFixed(outcome.parent1Gender) && first.length > 0 && firstEligible.length === 0) ||
    (isFixed(outcome.parent2Gender) && second.length > 0 && secondEligible.length === 0);
  return {
    compatible: false, first: null, second: null,
    firstEligible: firstEligible.length, secondEligible: secondEligible.length,
    unknownGender,
    reason: !bothSpeciesPresent
      ? "missing_parent"
      : fixedMissing
        ? "fixed_gender_missing"
        : unknownGender > 0 && (firstEligible.length === 0 || secondEligible.length === 0)
          ? "gender_unknown"
          : "same_gender_only",
  };
}

export function genderCounts(pals: readonly RosterPal[]): { male: number; female: number; unknown: number } {
  return {
    male: pals.filter((pal) => pal.gender === "male").length,
    female: pals.filter((pal) => pal.gender === "female").length,
    unknown: pals.filter((pal) => pal.gender !== "male" && pal.gender !== "female").length,
  };
}

function genderMatches(actual: RosterPal["gender"], required: PalGender): boolean {
  if (actual !== "male" && actual !== "female") return false;
  if (required === "MALE") return actual === "male";
  if (required === "FEMALE") return actual === "female";
  return true;
}

function isFixed(gender: PalGender): boolean {
  return gender === "MALE" || gender === "FEMALE";
}

function unknownCount(pals: readonly RosterPal[]): number {
  return pals.filter((pal) => pal.gender !== "male" && pal.gender !== "female").length;
}
