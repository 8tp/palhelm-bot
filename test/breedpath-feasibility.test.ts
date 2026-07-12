import { describe, expect, it } from "vitest";
import { breedingFeasibilityNotes, selectBreedpathScope } from "../src/commands/breedpath.js";
import type { BreedingStep, PalKnowledge } from "../src/knowledge/paldeck.js";

const pal = (internalId: string): PalKnowledge => ({
  internalId, name: internalId, dexNumber: 1, isVariant: false, elements: [],
  workSuitabilities: [], learnset: [], guaranteedPassives: [], hp: 1, attack: 1,
  defense: 1, rarity: 1, breedingPower: 1, minWildLevel: 1, maxWildLevel: 1,
  size: "M", nocturnal: false, walkSpeed: 1, runSpeed: 1, rideSprintSpeed: 1,
  transportSpeed: 1, stamina: 1, foodAmount: 1, maxFullStomach: 1, price: 1,
});

describe("breeding path feasibility notes", () => {
  it("warns when a same-species pairing has only one observed owned copy", () => {
    const anubis = pal("Anubis");
    const step: BreedingStep = {
      parent1: anubis, parent2: anubis, child: pal("Child"),
      parent1Gender: "WILDCARD", parent2Gender: "WILDCARD",
      parent1Owned: true, parent2Owned: true,
    };
    const male = {
      instanceId: "a", characterId: "Anubis", displayName: "Anubis", level: 10,
      isAlpha: false, isLucky: false, ownerUid: "u", ownerName: "Player", gender: "male" as const,
    };
    const female = { ...male, instanceId: "b", gender: "female" as const };
    expect(breedingFeasibilityNotes([step], new Map([["anubis", [male]]]))).toEqual([
      expect.stringContaining("no observed compatible"),
      expect.stringContaining("does not guarantee desired passive"),
    ]);
    expect(breedingFeasibilityNotes([step], new Map([["anubis", [male, female]]]))).toEqual([
      expect.stringContaining("does not guarantee desired passive"),
    ]);
  });
});

describe("breeding path roster scope", () => {
  const players = [
    { uid: "hunter", name: "Hunter", online: true, level: 40, guildId: null, guildName: null, firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-07-12T00:00:00Z", playtimeSec: 100 },
    { uid: "luna", name: "Luna", online: false, level: 35, guildId: null, guildName: null, firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-07-12T00:00:00Z", playtimeSec: 100 },
  ];

  it("defaults to the caller's linked player and never silently falls back to the server", () => {
    expect(selectBreedpathScope(players, null, null, "hunter")).toMatchObject({
      kind: "player",
      player: { uid: "hunter" },
    });
    expect(selectBreedpathScope(players, null, null, null)).toEqual({ kind: "unlinked" });
    expect(selectBreedpathScope(players, null, null, "missing")).toEqual({ kind: "linked_player_missing" });
  });

  it("supports an explicit server scope or specific-player override", () => {
    expect(selectBreedpathScope(players, null, "server", null)).toEqual({ kind: "server" });
    expect(selectBreedpathScope(players, "Luna", "server", null)).toMatchObject({
      kind: "player",
      player: { uid: "luna" },
    });
  });
});
