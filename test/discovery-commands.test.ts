import { describe, expect, it, vi } from "vitest";
import { collectionCommand } from "../src/commands/collection.js";
import { dexCommand } from "../src/commands/dex.js";
import { recordsCommand } from "../src/commands/records.js";
import { breedCommand } from "../src/commands/breed.js";
import { workersCommand } from "../src/commands/workers.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";

const snapshot: WorldSnapshot = {
  capturedAt: "2026-07-11T12:00:00.000Z",
  lastParseAt: "2026-07-11T12:00:00.000Z",
  formatDrift: true,
  metricsCurrent: null,
  server: null,
  players: [
    {
      uid: "luna",
      name: "Luna",
      online: true,
      level: 40,
      guildId: "g1",
      guildName: "Wayfarers",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-07-11T12:00:00.000Z",
      playtimeSec: 200 * 3_600,
    },
    {
      uid: "hunter",
      name: "Hunter",
      online: false,
      level: 35,
      guildId: "g1",
      guildName: "Wayfarers",
      firstSeenAt: "2026-02-01T00:00:00.000Z",
      lastSeenAt: "2026-07-10T12:00:00.000Z",
      playtimeSec: 150 * 3_600,
    },
  ],
  pals: [
    {
      instanceId: "a1",
      characterId: "Anubis",
      displayName: "Anubis",
      level: 42,
      isAlpha: true,
      isLucky: false,
      ownerUid: "luna",
      ownerName: "",
      inParty: true,
    },
    {
      instanceId: "a2",
      characterId: "Anubis",
      displayName: "Anubis",
      level: 30,
      isAlpha: false,
      isLucky: true,
      ownerUid: "hunter",
      ownerName: "Hunter",
      inParty: false,
    },
    {
      instanceId: "l1",
      characterId: "SheepBall",
      displayName: "Lamball",
      level: 12,
      isAlpha: false,
      isLucky: false,
      ownerUid: "luna",
      ownerName: "Luna",
    },
  ],
  guilds: [
    {
      id: "g1",
      name: "Wayfarers",
      adminUid: "luna",
      memberCount: 2,
      members: [{ uid: "luna", name: "Luna" }, { uid: "hunter", name: "Hunter" }],
      bases: [{ id: "b1", location: { x: 1, y: 2 }, level: 20 }],
    },
  ],
};

function harness(options: Record<string, string | null>, source: WorldSnapshot = snapshot) {
  const editReply = vi.fn().mockResolvedValue({
    createMessageComponentCollector: vi.fn(() => ({ on: vi.fn() })),
  });
  const interaction = {
    id: "interaction-1",
    user: { id: "requester" },
    deferReply: vi.fn(),
    editReply,
    options: {
      getString: (name: string, required?: boolean) => {
        const value = options[name] ?? null;
        if (required && value === null) throw new Error(`missing ${name}`);
        return value;
      },
    },
  };
  const binary = vi.fn().mockResolvedValue(null);
  const catalogue = [
    { internalId: "Anubis", name: "Anubis", dexNumber: 100, isVariant: false, elements: ["Ground"], workSuitabilities: [{ id: "Mining", name: "Mining", level: 3 }, { id: "Handiwork", name: "Handiwork", level: 4 }], learnset: [{ id: "StoneBlast", name: "Stone Blast", unlockLevel: 1 }], hp: 120, attack: 130, defense: 100, rarity: 8, breedingPower: 570 },
    { internalId: "SheepBall", name: "Lamball", dexNumber: 1, isVariant: false, elements: ["Neutral"], workSuitabilities: [{ id: "Handiwork", name: "Handiwork", level: 1 }], learnset: [], hp: 70, attack: 70, defense: 70, rarity: 1, breedingPower: 1470 },
    { internalId: "GrassMammoth", name: "Mammorest", dexNumber: 90, isVariant: false, elements: ["Grass"], workSuitabilities: [{ id: "Mining", name: "Mining", level: 2 }], learnset: [], hp: 150, attack: 100, defense: 90, rarity: 7, breedingPower: 300 },
  ];
  const metadata = { schemaVersion: 1 as const, generatedAt: "2026-07-11T00:00:00Z", sources: [{ name: "PalCalc" as const, version: "v1.17.2", url: "https://example.test", attribution: "MIT" }] };
  const resolve = (query: string) => catalogue.find((pal) => pal.internalId.toLowerCase() === query.toLowerCase() || pal.name.toLowerCase() === query.toLowerCase()) ?? null;
  const knowledge = {
    init: vi.fn().mockResolvedValue(undefined),
    get: vi.fn((query: string) => ({ data: resolve(query), metadata })),
    list: vi.fn(() => ({ data: catalogue, metadata })),
    parentsFor: vi.fn((query: string) => ({ data: query.toLowerCase() === "anubis" ? [{ parent1: catalogue[1], parent1Gender: "WILDCARD", parent2: catalogue[2], parent2Gender: "OPPOSITE_WILDCARD", child: catalogue[0] }] : [], metadata })),
    status: vi.fn(() => ({ ready: true, palCount: 3, breedingCombinationCount: 1, metadata })),
  };
  const ctx = {
    snapshots: { get: vi.fn().mockResolvedValue(source) },
    observations: { trackingStartedAt: vi.fn(() => "2026-07-01T00:00:00.000Z") },
    config: { suppressDriftNotices: true, serverLabel: "the server" },
    session: { binary },
    knowledge,
  };
  return { interaction, editReply, ctx, binary };
}

function json(editReply: ReturnType<typeof vi.fn>) {
  return editReply.mock.calls[0]![0].embeds[0].toJSON();
}

describe("records, collection, and dex commands", () => {
  it("renders current records without a suppressed drift warning", async () => {
    const { interaction, editReply, ctx } = harness({});
    await recordsCommand.execute(interaction as never, ctx as never);
    const embed = json(editReply);
    expect(embed.description ?? "").not.toContain("format drift");
    expect(embed.fields?.find((field: { name: string }) => field.name === "Highest-level Pal")?.value).toContain("Lv 42 Anubis ⭐ — Luna");
    expect(embed.fields?.find((field: { name: string }) => field.name === "Longest playtime")?.value).toContain("Luna — 8d 8h");
  });

  it("labels an unresolvable record owner instead of rendering a blank name", async () => {
    const unknownOwner: WorldSnapshot = {
      ...snapshot,
      pals: [{
        ...snapshot.pals[0]!,
        displayName: "Mammorest",
        level: 50,
        ownerUid: "unmatched-owner",
        ownerName: "",
      }],
    };
    const { interaction, editReply, ctx } = harness({}, unknownOwner);
    await recordsCommand.execute(interaction as never, ctx as never);
    expect(json(editReply).fields?.find((field: { name: string }) => field.name === "Highest-level Pal")?.value)
      .toContain("Lv 50 Mammorest ⭐ — Owner unavailable");
  });

  it("renders boss IDs as the base species with a crown", async () => {
    const bossSnapshot: WorldSnapshot = {
      ...snapshot,
      pals: [{
        ...snapshot.pals[0]!,
        characterId: "BOSS_GrassMammoth",
        displayName: "Mammorest",
        level: 50,
        ownerUid: "hunter",
        ownerName: "Hunter",
      }, {
        ...snapshot.pals[1]!,
        characterId: "GrassMammoth",
        displayName: "Mammorest",
        level: 35,
      }],
    };
    const records = harness({}, bossSnapshot);
    await recordsCommand.execute(records.interaction as never, records.ctx as never);
    const value = json(records.editReply).fields?.find((field: { name: string }) => field.name === "Highest-level Pal")?.value;
    expect(value).toContain("Lv 50 Mammorest 👑 — Hunter");
    expect(value).not.toContain("BOSS_");

    const collection = harness({ player: null }, bossSnapshot);
    await collectionCommand.execute(collection.interaction as never, collection.ctx as never);
    expect(json(collection.editReply).description).toContain("**1 / 3 species (33.3%)** · 2 current Pal instances");
    expect(json(collection.editReply).description).toContain("Mammorest 👑 🍀 ×2");
  });

  it("renders server and player collections from the same snapshot", async () => {
    const server = harness({ player: null });
    await collectionCommand.execute(server.interaction as never, server.ctx as never);
    expect(json(server.editReply).description).toContain("**2 / 3 species (66.7%)** · 3 current Pal instances");
    expect(json(server.editReply).description).toContain("/dex pal:GrassMammoth");
    expect(json(server.editReply).description).toContain("/breed child:GrassMammoth");

    const luna = harness({ player: "luna" });
    await collectionCommand.execute(luna.interaction as never, luna.ctx as never);
    expect(json(luna.editReply).title).toContain("Luna's Collection");
    expect(json(luna.editReply).description).toContain("**2 / 3 species (66.7%)** · 2 current Pal instances");
  });

  it("builds a source-safe dex card and only fetches the panel icon", async () => {
    const { interaction, editReply, ctx, binary } = harness({ pal: "Anubis" });
    await dexCommand.execute(interaction as never, ctx as never);
    const payload = editReply.mock.calls[0]![0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("2 currently owned by 2 players");
    expect(embed.fields.find((field: { name: string }) => field.name === "Base scaling").value).toContain("ATK 130");
    expect(embed.description).toContain("Open Anubis on the Palworld Wiki");
    expect(embed.url).toBe("https://palworld.wiki.gg/wiki/Anubis");
    expect(payload.components[0].toJSON().components[0].custom_id).toBe("dex_section:interaction-1");
    expect(binary).toHaveBeenCalledWith("/api/v1/paldeck/icon/Anubis");
  });

  it("ranks breeding pairs by currently observed parents", async () => {
    const { interaction, editReply, ctx } = harness({ child: "Anubis", player: null });
    await breedCommand.execute(interaction as never, ctx as never);
    expect(json(editReply).description).toContain("◐ **Lamball** + **Mammorest**");
    expect(json(editReply).description).toContain("Ownership scope: **all current rosters on the server**");
    expect(json(editReply).description).toContain("Luna · ♂0 ♀0 ?1 · not currently observed");
  });

  it("ranks current workers by suitability then Pal level", async () => {
    const { interaction, editReply, ctx } = harness({ job: "Mining", player: null });
    await workersCommand.execute(interaction as never, ctx as never);
    expect(json(editReply).description).toContain("**Anubis ⭐** — Mining Lv 3 · Pal Lv 42");
    expect(json(editReply).description).toContain("**Anubis 🍀** — Mining Lv 3 · Pal Lv 30");
  });
});
