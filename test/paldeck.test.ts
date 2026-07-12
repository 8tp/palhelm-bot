import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PalKnowledgeService, type PalKnowledgeSourceUrls } from "../src/knowledge/paldeck.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const urls: PalKnowledgeSourceUrls = {
  pspPals: "https://fixture/psp-pals",
  pspEnglishPals: "https://fixture/psp-names",
  pspEnglishElements: "https://fixture/psp-elements",
  pspEnglishWork: "https://fixture/psp-work",
  palCalcDb: "https://fixture/palcalc-db",
  palCalcBreeding: "https://fixture/palcalc-breeding",
};

const fixtures: Record<string, unknown> = {
  [urls.pspPals]: {
    SheepBall: { tribe: "SheepBall", element_types: ["Normal"], scaling: { hp: 70, attack: 70, defense: 70 }, rarity: 1, work_suitability: { Handcraft: 1, MonsterFarm: 1, Mining: 0 }, skill_set: { AirCanon: 1 } },
    Anubis: { tribe: "Anubis", element_types: ["Earth"], scaling: { hp: 120, attack: 130, defense: 100 }, rarity: 10, work_suitability: { Handcraft: 6, Mining: 6, Transport: 4 } },
  },
  [urls.pspEnglishPals]: { SheepBall: { localized_name: "Lamball", description: "must not cache" }, Anubis: { localized_name: "Anubis", description: "must not cache" } },
  [urls.pspEnglishElements]: { Normal: { localized_name: "Neutral" }, Earth: { localized_name: "Ground" } },
  [urls.pspEnglishWork]: { Handcraft: { localized_name: "Handiwork" }, MonsterFarm: { localized_name: "Farming" }, Mining: { localized_name: "Mining" }, Transport: { localized_name: "Transporting" } },
  [urls.palCalcDb]: { Elements: [{ InternalName: "Normal", Name: "Neutral" }], ActiveSkills: [{ InternalName: "AirCanon", Name: "Air Cannon", ElementInternalName: "Normal", Power: 25, CooldownSeconds: 2, HasSkillFruit: true, CanInherit: true, Description: "must not cache either" }], PassiveSkills: [{ InternalName: "SoftSkin", Name: "Soft Skin", Rank: -1, RandomInheritanceAllowed: true, Description: "must not cache passive description" }], Pals: [
    { Id: { PalDexNo: 1, IsVariant: false }, Name: "Lamball", InternalName: "SheepBall", BreedingPower: 1500, Hp: 1, Attack: 1, Defense: 1, Rarity: 1, WorkSuitability: {}, GuaranteedPassivesInternalIds: ["SoftSkin"], MinWildLevel: 1, MaxWildLevel: 20, Size: "XS", Nocturnal: false, WalkSpeed: 40, RunSpeed: 400, RideSprintSpeed: 550, TransportSpeed: 160, Stamina: 100, FoodAmount: 1, MaxFullStomach: 100, Price: 421 },
    { Id: { PalDexNo: 100, IsVariant: false }, Name: "Anubis", InternalName: "Anubis", BreedingPower: 570, Hp: 1, Attack: 1, Defense: 1, Rarity: 10, WorkSuitability: {}, GuaranteedPassivesInternalIds: [] },
    { Id: { PalDexNo: 999, IsVariant: true }, Name: "Fallback Pal", InternalName: "OnlyPalCalc", BreedingPower: 900, Hp: 80, Attack: 90, Defense: 100, Rarity: 4, WorkSuitability: { Cooling: 2 } },
  ] },
  [urls.palCalcBreeding]: { Breeding: [
    { Parent1ID: { PalDexNo: 1, IsVariant: false }, Parent1Gender: "WILDCARD", Parent2ID: { PalDexNo: 100, IsVariant: false }, Parent2Gender: "WILDCARD", ChildID: { PalDexNo: 999, IsVariant: true } },
  ] },
};

async function setup(fetchImpl?: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), "paldeck-test-"));
  dirs.push(dir);
  const cachePath = join(dir, "knowledge.json");
  const mocked = fetchImpl ?? vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ "User-Agent": expect.stringContaining("Palhelm") });
    return new Response(JSON.stringify(fixtures[String(input)]));
  }) as typeof fetch;
  return { cachePath, service: new PalKnowledgeService(cachePath, { sourceUrls: urls, fetch: mocked, now: () => new Date("2026-07-11T12:00:00Z") }), mocked };
}

describe("PalKnowledgeService", () => {
  it("coalesces loading, normalizes source data, and writes a private cache", async () => {
    const { service, cachePath, mocked } = await setup();
    await Promise.all([service.init(), service.init()]);

    expect(mocked).toHaveBeenCalledTimes(6);
    expect(service.status()).toMatchObject({ ready: true, palCount: 3, breedingCombinationCount: 1 });
    expect(service.get("sheepball").data).toMatchObject({
      name: "Lamball",
      elements: ["Neutral"],
      hp: 70,
      minWildLevel: 1,
      maxWildLevel: 20,
      size: "XS",
      learnset: [{ id: "AirCanon", name: "Air Cannon", unlockLevel: 1, element: "Neutral", power: 25, cooldownSeconds: 2, hasSkillFruit: true, inheritable: true }],
      guaranteedPassives: [{ id: "SoftSkin", name: "Soft Skin", rank: -1, inheritable: true }],
    });
    expect(service.get("fallback").data).toMatchObject({ internalId: "OnlyPalCalc", isVariant: true, workSuitabilities: [{ id: "Cooling", level: 2 }] });
    expect(service.list().data.map((pal) => pal.internalId)).toEqual(["SheepBall", "Anubis", "OnlyPalCalc"]);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    const disk = await readFile(cachePath, "utf8");
    expect(disk).not.toContain("must not cache");
    expect(disk).not.toContain("must not cache either");
    expect(disk).not.toContain("must not cache passive description");
    expect(disk).not.toContain("icon");
  });

  it("rebuilds an obsolete schema-1 cache from pinned sources", async () => {
    const { service, cachePath, mocked } = await setup();
    await writeFile(cachePath, JSON.stringify({ metadata: { schemaVersion: 1 }, pals: [], breeding: [] }));

    await service.init();

    expect(mocked).toHaveBeenCalledTimes(6);
    expect(service.status().metadata?.schemaVersion).toBe(2);
    expect(JSON.parse(await readFile(cachePath, "utf8")).metadata.schemaVersion).toBe(2);
  });

  it("resolves names/substrings and returns exact breeding facts with metadata", async () => {
    const { service } = await setup();
    await service.init();

    expect(service.search("anu", 5).data.map((pal) => pal.name)).toEqual(["Anubis"]);
    expect(service.getExact("Anubis").data?.name).toBe("Anubis");
    expect(service.getExact("anu").data).toBeNull();
    expect(service.getExact("Aerodeus").data).toBeNull();
    const bred = service.breed("Lamball", "anub");
    expect(bred.data[0]).toMatchObject({ child: { internalId: "OnlyPalCalc" }, parent1Gender: "WILDCARD" });
    expect(bred.metadata.sources.map((source) => source.version)).toHaveLength(2);
    expect(service.parentsFor("Fallback Pal", 5).data).toHaveLength(1);
  });

  it("loads a last-good disk cache without touching the network", async () => {
    const first = await setup();
    await first.service.init();
    const offline = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;
    const restarted = new PalKnowledgeService(first.cachePath, { sourceUrls: urls, fetch: offline });

    await restarted.init();

    expect(offline).not.toHaveBeenCalled();
    expect(restarted.get("Anubis").data?.dexNumber).toBe(100);
  });

  it("fails safely when no cache or source is available", async () => {
    const offline = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;
    const { service } = await setup(offline);
    await expect(service.init()).rejects.toThrow("offline");
    expect(service.status().ready).toBe(false);
  });

  it("plans the shortest breeding path from owned species", async () => {
    const { service } = await setup();
    await service.init();

    // SheepBall + Anubis -> OnlyPalCalc (Fallback Pal); both parents owned.
    const path = service.breedingPath("Fallback Pal", new Set(["sheepball", "anubis"])).data!;
    expect(path).toMatchObject({ alreadyOwned: false, reachable: true });
    expect(path.steps).toHaveLength(1);
    expect(path.steps[0]).toMatchObject({
      child: { internalId: "OnlyPalCalc" },
      parent1Owned: true,
      parent2Owned: true,
    });

    // Already present in the owned set: no steps needed.
    expect(service.breedingPath("Fallback Pal", new Set(["onlypalcalc"])).data)
      .toMatchObject({ alreadyOwned: true, reachable: true, steps: [] });

    // Missing a required parent with no recipe to produce it: unreachable.
    expect(service.breedingPath("Fallback Pal", new Set(["sheepball"])).data)
      .toMatchObject({ alreadyOwned: false, reachable: false, steps: [] });

    // Unknown target resolves to null rather than throwing.
    expect(service.breedingPath("Nonexistent Pal", new Set(["sheepball"])).data).toBeNull();
  });
});
