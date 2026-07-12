import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../src/discord/commands.js";
import type { KnowledgeMetadata, PalKnowledge, PalKnowledgeService } from "../src/knowledge/paldeck.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";
import { aiToolDefinitions, executeAiTool } from "../src/ai/tools.js";

const snapshot: WorldSnapshot = {
  capturedAt: "2020-01-01T00:00:00.000Z",
  lastParseAt: "2020-01-01T00:00:00.000Z",
  formatDrift: true,
  server: { name: "Test Server", description: "", version: "1.0", state: "running", uptimeSec: 90 },
  metricsCurrent: {
    fps: 58,
    fpsAvg: 59,
    frameTimeMs: 17.2,
    players: 1,
    maxPlayers: 16,
    day: 42,
    uptimeSec: 90,
    baseCamps: 1,
  },
  guilds: [{ id: "g1", name: "Guild", adminUid: "u2", memberCount: 2, members: [], bases: [{ id: "b1", location: { x: 100, y: 200 }, level: 10 }] }],
  players: [
    {
      uid: "u2", name: "Beta", online: false, level: 20, guildId: "g1", guildName: "Guild",
      firstSeenAt: "2020-01-01T00:00:00Z", lastSeenAt: "2020-01-02T00:00:00Z", playtimeSec: 3_600,
    },
    {
      uid: "u1", name: "Alpha", online: true, level: 20, guildId: null, guildName: null,
      firstSeenAt: "2020-01-01T00:00:00Z", lastSeenAt: "2020-01-03T00:00:00Z", playtimeSec: 7_200,
    },
  ],
  pals: [
    {
      instanceId: "p1", characterId: "Anubis", displayName: "Anubis", level: 30,
      isAlpha: true, isLucky: false, ownerUid: "u2", ownerName: "", inParty: true,
      gender: "male",
    },
    {
      instanceId: "p2", characterId: "Anubis", displayName: "Anubis", level: 25,
      isAlpha: false, isLucky: true, ownerUid: "u2", ownerName: "Beta",
      gender: "female", placement: "base", baseId: "b1", ownerSource: "last_observed",
    },
    {
      instanceId: "p3", characterId: "SheepBall", displayName: "Lamball", level: 10,
      isAlpha: false, isLucky: false, ownerUid: "u1", ownerName: "Alpha",
      gender: "female",
    },
    {
      instanceId: "p4", characterId: "GhostPal", displayName: "Ghost Pal", level: 5,
      isAlpha: false, isLucky: false, ownerUid: "missing", ownerName: "",
      placement: "base", baseId: "b1", ownerSource: "unresolved",
    },
  ],
};

function context() {
  const get = vi.fn().mockResolvedValue(snapshot);
  return { ctx: { snapshots: { get } } as unknown as BotContext, get };
}

const metadata: KnowledgeMetadata = {
  schemaVersion: 2,
  generatedAt: "2026-07-11T12:00:00.000Z",
  sources: [{
    name: "PalCalc",
    version: "commit-1",
    url: "https://example.test/db.json",
    attribution: "Test attribution",
  }],
};

const anubis: PalKnowledge = {
  internalId: "Anubis",
  name: "Anubis",
  dexNumber: 139,
  isVariant: false,
  elements: ["Ground"],
  workSuitabilities: [
    { id: "Handcraft", name: "Handiwork", level: 6 },
    { id: "Mining", name: "Mining", level: 6 },
  ],
  hp: 120,
  attack: 130,
  defense: 100,
  rarity: 10,
  breedingPower: 480,
  learnset: [{ id: "RockLance", name: "Rock Lance", unlockLevel: 50, element: "Ground", power: 150, cooldownSeconds: 55, hasSkillFruit: false, inheritable: true }],
  guaranteedPassives: [{ id: "ElementBoost_Earth_2_PAL", name: "Earth Emperor", rank: 3, inheritable: false }],
  minWildLevel: 55,
  maxWildLevel: 80,
  size: "M",
  nocturnal: false,
  walkSpeed: 160,
  runSpeed: 800,
  rideSprintSpeed: 1000,
  transportSpeed: 480,
  stamina: 100,
  foodAmount: 8,
  maxFullStomach: 540,
  price: 3217,
};

const lamball: PalKnowledge = {
  ...anubis,
  internalId: "SheepBall",
  name: "Lamball",
  dexNumber: 1,
  elements: ["Neutral"],
  workSuitabilities: [{ id: "Handcraft", name: "Handiwork", level: 1 }],
  breedingPower: 3050,
};

function knowledgeContext() {
  const service = {
    init: vi.fn().mockResolvedValue(undefined),
    status: vi.fn(() => ({ ready: true, palCount: 2, breedingCombinationCount: 1, metadata })),
    search: vi.fn(() => ({ data: [anubis, lamball], metadata })),
    get: vi.fn((query: string) => ({
      data: query.toLowerCase() === "anubis"
        ? anubis
        : ["sheepball", "lamball"].includes(query.toLowerCase())
          ? lamball
          : null,
      metadata,
    })),
    getExact: vi.fn((query: string) => ({
      data: query.toLowerCase() === "anubis"
        ? anubis
        : ["sheepball", "lamball"].includes(query.toLowerCase())
          ? lamball
          : null,
      metadata,
    })),
    breed: vi.fn(() => ({
      data: [{
        parent1: anubis,
        parent1Gender: "WILDCARD",
        parent2: lamball,
        parent2Gender: "WILDCARD",
        child: lamball,
      }],
      metadata,
    })),
    parentsFor: vi.fn(() => ({
      data: [{
        parent1: anubis,
        parent1Gender: "WILDCARD",
        parent2: lamball,
        parent2Gender: "WILDCARD",
        child: lamball,
      }],
      metadata,
    })),
  } as unknown as PalKnowledgeService;
  const base = context();
  const ctx = Object.assign(base.ctx, { knowledge: service });
  return { ctx, service, snapshotGet: base.get };
}

describe("AI snapshot tools", () => {
  it("exports unique OpenRouter-compatible definitions", () => {
    const names = aiToolDefinitions.map((tool) => tool.function.name);
    expect(names).toHaveLength(19);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of aiToolDefinitions) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters.additionalProperties).toBe(false);
    }
  });

  it("returns explicit snapshot quality and deterministic player order", async () => {
    const { ctx, get } = context();
    const result = await executeAiTool("list_players", {}, ctx);
    expect(result).toMatchObject({
      ok: true,
      snapshot: { capturedAt: snapshot.capturedAt, formatDrift: true, stale: true },
      data: { total: 2, players: [{ name: "Alpha" }, { name: "Beta" }] },
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it("uses snapshot facts for comparison, records, owners, and collection", async () => {
    const compared = await executeAiTool("compare_players", { a: "u1", b: "Beta" }, context().ctx);
    expect(compared).toMatchObject({
      ok: true,
      data: { a: { name: "Alpha", currentPals: 1 }, b: { name: "Beta", currentPals: 2 } },
    });

    const records = await executeAiTool("get_records", {}, context().ctx);
    expect(records).toMatchObject({
      data: { highestPlayerLevel: { name: "Alpha" }, highestLevelPal: { displayName: "Anubis" } },
    });

    const owners = await executeAiTool("find_pal_owners", { pal: "Anubis" }, context().ctx);
    expect(owners).toMatchObject({ data: { total: 2, owners: [{ name: "Beta", count: 2 }] } });
    expect(records).toMatchObject({ data: { highestLevelPal: { ownerName: "Beta" } } });

    const missingOwner = await executeAiTool("find_pal_owners", { pal: "GhostPal" }, context().ctx);
    expect(missingOwner).toMatchObject({ data: { owners: [{ name: "owner unavailable" }] } });

    const collection = await executeAiTool("get_collection", { player: "Alpha" }, context().ctx);
    expect(collection).toMatchObject({
      data: {
        observedSpecies: 1,
        currentPalInstances: 1,
        complete: true,
        truncated: false,
        speciesColumns: ["name", "instances", "maxLevel", "alpha", "boss", "lucky"],
        species: [["Lamball", 1, 10, false, false, false]],
      },
    });
  });

  it("returns every species in a player collection and can inspect one beyond the old 50-species cap", async () => {
    const manyPals = Array.from({ length: 75 }, (_, index) => ({
      instanceId: `pal-${index}`,
      characterId: `Species_${String(index).padStart(2, "0")}`,
      displayName: `Species ${String(index).padStart(2, "0")}`,
      level: index + 1,
      isAlpha: index === 74,
      isLucky: false,
      ownerUid: "u1",
      ownerName: "Alpha",
    }));
    const largeSnapshot = { ...snapshot, pals: manyPals };
    const ctx = { snapshots: { get: vi.fn().mockResolvedValue(largeSnapshot) } } as unknown as BotContext;

    const full = await executeAiTool("get_collection", { player: "Alpha" }, ctx);
    expect(full).toMatchObject({
      ok: true,
      data: { observedSpecies: 75, complete: true, truncated: false },
    });
    expect((full.data as { species: unknown[] }).species).toHaveLength(75);

    const specific = await executeAiTool(
      "get_collection",
      { player: "Alpha", pal: "Species 74" },
      ctx,
    );
    expect(specific).toMatchObject({
      ok: true,
      data: {
        observedSpecies: 75,
        matchedSpecies: 1,
        complete: true,
        species: [["Species 74", 1, 75, true, false, false]],
      },
    });
  });

  it("resolves self only through the requester's durable player link", async () => {
    const linked = await executeAiTool("get_collection", { player: "self" }, context().ctx, "u1");
    expect(linked).toMatchObject({
      ok: true,
      data: {
        subject: { uid: "u1", name: "Alpha" },
        species: [["Lamball", 1, 10, false, false, false]],
      },
    });

    const unlinked = await executeAiTool("get_collection", { player: "self" }, context().ctx);
    expect(unlinked).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("rejects invalid and unknown calls without touching snapshots or throwing", async () => {
    const { ctx, get } = context();
    await expect(executeAiTool("get_player", { nameOrUid: "", extra: true }, ctx)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    await expect(executeAiTool("delete_server", {}, ctx)).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_tool" },
    });
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("raw detail"); } });
    await expect(executeAiTool("get_server_status", hostile, ctx)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("converts snapshot failures into a safe structured error", async () => {
    const ctx = {
      snapshots: { get: vi.fn().mockRejectedValue(new Error("secret upstream detail")) },
    } as unknown as BotContext;
    await expect(executeAiTool("get_server_status", {}, ctx)).resolves.toEqual({
      ok: false,
      error: {
        code: "snapshot_unavailable",
        message: "Public snapshot data is temporarily unavailable.",
      },
    });
  });

  it("uses knowledge only for rich Pal and breeding tools", async () => {
    const { ctx, service, snapshotGet } = knowledgeContext();
    const searched = await executeAiTool("search_pal_knowledge", { query: "an" }, ctx);
    expect(searched).toMatchObject({
      ok: true,
      knowledge: { schemaVersion: 2, sources: [{ version: "commit-1" }] },
      data: { total: 2 },
    });
    expect((searched.data as { pals: unknown[] }).pals).toEqual(
      expect.arrayContaining([expect.objectContaining({ internalId: "Anubis" })]),
    );

    const detail = await executeAiTool("get_pal_knowledge", { pal: "Anubis" }, ctx);
    expect(detail).toMatchObject({
      data: {
        internalId: "Anubis",
        elements: ["Ground"],
        learnset: [{ name: "Rock Lance", unlockLevel: 50, power: 150, cooldownSeconds: 55 }],
        guaranteedPassives: [{ name: "Earth Emperor", rank: 3, inheritable: false }],
        wildProfile: { minLevel: 55, maxLevel: 80, nocturnal: false },
        unavailableInPinnedSources: expect.arrayContaining(["partner skills", "drops", "spawn coordinates", "recipes", "technology unlocks"]),
      },
    });
    expect((detail.data as { workSuitabilities: unknown[] }).workSuitabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Handiwork", level: 6 })]),
    );

    const bred = await executeAiTool(
      "calculate_breeding_pair",
      { parent1: "Anubis", parent2: "Lamball" },
      ctx,
    );
    expect(bred).toMatchObject({ data: { outcomes: [{ child: { name: "Lamball" } }] } });

    const parents = await executeAiTool(
      "find_breeding_parents",
      { child: "Lamball", limit: 2 },
      ctx,
    );
    expect(parents).toMatchObject({ data: { requestedLimit: 2, totalReturned: 1 } });
    expect(service.init).toHaveBeenCalledTimes(4);
    expect(snapshotGet).not.toHaveBeenCalled();
  });

  it("rejects invented Pal names through exact catalogue validation", async () => {
    const { ctx } = knowledgeContext();
    const result = await executeAiTool(
      "validate_pal_names",
      { names: "Anubis, Aerodeus | Lamball" },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        recognized: [{ name: "Anubis" }, { name: "Lamball" }],
        unrecognized: ["Aerodeus"],
        rule: "Do not claim unrecognized entries are Pals.",
      },
    });
  });

  it("ranks owned workers by knowledge work level and Pal level", async () => {
    const { ctx } = knowledgeContext();
    const result = await executeAiTool("recommend_owned_workers", { work: "Handiwork" }, ctx);
    expect(result).toMatchObject({
      ok: true,
      snapshot: { capturedAt: snapshot.capturedAt },
      knowledge: { generatedAt: metadata.generatedAt },
      data: {
        work: "Handiwork",
        total: 3,
        workers: [
          { displayName: "Anubis", workLevel: 6, palLevel: 30, ownerName: "Beta" },
          { displayName: "Anubis", workLevel: 6, palLevel: 25, ownerName: "Beta (last observed)" },
          { displayName: "Lamball", workLevel: 1, palLevel: 10, ownerName: "Alpha" },
        ],
      },
    });

    const filtered = await executeAiTool(
      "recommend_owned_workers",
      { work: "Handcraft", player: "Alpha" },
      ctx,
    );
    expect(filtered).toMatchObject({ data: { total: 1, player: { name: "Alpha" } } });
  });

  it("returns targeted owned-Pal detail and a compact balanced base setup", async () => {
    const { ctx } = knowledgeContext();
    const detail = await executeAiTool(
      "get_owned_pal_detail",
      { player: "Beta", pal: "Anubis" },
      ctx,
    );
    expect(detail).toMatchObject({
      ok: true,
      data: {
        matchCount: 2,
        selectedHighestLevelMatch: true,
        instance: { instanceId: "p1", displayName: "Anubis", level: 30, inParty: true },
        species: { workSuitabilities: expect.arrayContaining([expect.objectContaining({ name: "Mining", level: 6 })]) },
      },
    });

    const setup = await executeAiTool(
      "recommend_owned_base_setup",
      { player: "self", slots: 2 },
      ctx,
      "u2",
    );
    expect(setup).toMatchObject({
      ok: true,
      data: {
        player: { uid: "u2", name: "Beta" },
        requestedSlots: 2,
        selectedWorkers: 2,
        rosterEvidence: {
          ownedPalInstances: 2,
          eligibleWorkerInstances: 2,
          knowledgeUnmatchedInstances: 0,
          complete: true,
          candidateColumns: ["name", "level", "gender", "alpha", "lucky", "work"],
          candidates: [
            ["Anubis", 30, "male", true, false, expect.stringContaining("Mining:6")],
            ["Anubis", 25, "female", false, true, expect.stringContaining("Mining:6")],
          ],
        },
        baseRosterEvidence: {
          available: true,
          currentWorkerInstances: 2,
          bases: [{
            number: 1,
            baseId: "b1",
            currentWorkerInstances: 2,
            workersComplete: true,
            workers: [
              ["p2", "Anubis", 25, "female", false, true, "Beta (last observed)", "last_observed", expect.stringContaining("Mining:6")],
              ["p4", "Ghost Pal", 5, "unknown", false, false, "owner unavailable", "unresolved", ""],
            ],
          }],
        },
        ownershipBoundary: expect.stringContaining("Base worker membership is exact"),
        workers: [
          { instanceId: "p1", displayName: "Anubis", work: expect.arrayContaining([{ role: "Mining", level: 6 }]) },
          { instanceId: "p2", displayName: "Anubis" },
        ],
      },
    });
    expect(JSON.stringify(setup).length).toBeLessThan(12_000);
  });

  it("ranks breeding paths using current parent ownership", async () => {
    const { ctx, service } = knowledgeContext();
    const result = await executeAiTool(
      "recommend_breeding_path",
      { child: "Lamball" },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      snapshot: { capturedAt: snapshot.capturedAt },
      data: {
        child: { name: "Lamball" },
        totalCombinations: 1,
        combinations: [{
          readyFromCurrentRoster: true,
          missingParentInstances: 0,
          parent1: { name: "Anubis", currentInstances: 2 },
          parent2: { name: "Lamball", currentInstances: 1 },
        }],
      },
    });
    expect(service.parentsFor).toHaveBeenCalledWith("Lamball", 100);
  });

  it("builds a combat party exclusively from the selected player's owned instances", async () => {
    const { ctx } = knowledgeContext();
    const result = await executeAiTool(
      "recommend_owned_party",
      { player: "self" },
      ctx,
      "u2",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        player: { uid: "u2", name: "Beta" },
        consideredInstances: 2,
        ownedSpecies: ["Anubis"],
        party: [
          ["Anubis", 30, ["Ground"], true, false, "p1"],
          ["Anubis", 25, ["Ground"], false, true, "p2"],
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("Lamball");
  });

  it("validates rich arguments and hides knowledge initialization failures", async () => {
    const { ctx, service, snapshotGet } = knowledgeContext();
    await expect(
      executeAiTool("find_breeding_parents", { child: "Lamball", limit: 0 }, ctx),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(service.init).not.toHaveBeenCalled();
    expect(snapshotGet).not.toHaveBeenCalled();

    const failed = knowledgeContext();
    vi.mocked(failed.service.init).mockRejectedValueOnce(new Error("private upstream detail"));
    await expect(executeAiTool("get_pal_knowledge", { pal: "Anubis" }, failed.ctx)).resolves.toEqual({
      ok: false,
      error: {
        code: "knowledge_unavailable",
        message: "Pal knowledge is temporarily unavailable.",
      },
    });
  });

  it("scopes web search to Palworld and returns bounded, cited results", async () => {
    const search = vi.fn().mockResolvedValue({
      query: "meteorite ore Palworld",
      answers: [],
      results: [
        { title: "Meteorite Ore - Palworld Wiki", url: "https://palworld.wiki.gg/wiki/Ore", content: "Refine into ingots.", engine: "google" },
      ],
    });
    const ctx = { webSearch: { search } } as unknown as BotContext;

    const result = await executeAiTool("search_palworld_web", { query: "meteorite ore" }, ctx);
    // Appends "Palworld" when the query omits it, keeping engines on-topic.
    expect(search).toHaveBeenCalledWith("meteorite ore Palworld");
    expect(result).toMatchObject({
      ok: true,
      data: { query: "meteorite ore Palworld", results: [{ url: "https://palworld.wiki.gg/wiki/Ore" }] },
    });

    // Does not double-append when the caller already said Palworld.
    await executeAiTool("search_palworld_web", { query: "Palworld sulfur" }, ctx);
    expect(search).toHaveBeenLastCalledWith("Palworld sulfur");
  });

  it("reports web search that is unconfigured, failing, or empty without throwing", async () => {
    await expect(
      executeAiTool("search_palworld_web", { query: "ore" }, { webSearch: null } as unknown as BotContext),
    ).resolves.toMatchObject({ ok: false, error: { code: "web_search_unavailable" } });

    const failing = { webSearch: { search: vi.fn().mockRejectedValue(new Error("upstream detail")) } } as unknown as BotContext;
    await expect(executeAiTool("search_palworld_web", { query: "ore" }, failing)).resolves.toMatchObject({
      ok: false,
      error: { code: "web_search_failed" },
    });

    const empty = { webSearch: { search: vi.fn().mockResolvedValue({ query: "x", answers: [], results: [] }) } } as unknown as BotContext;
    await expect(executeAiTool("search_palworld_web", { query: "ore" }, empty)).resolves.toMatchObject({
      ok: false,
      error: { code: "web_search_empty" },
    });
  });
});
