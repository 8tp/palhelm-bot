import { describe, expect, it, vi } from "vitest";
import { rareCommand } from "../src/commands/rare.js";
import { teamCommand } from "../src/commands/team.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";

const snapshot: WorldSnapshot = {
  capturedAt: "2026-07-11T12:00:00Z", lastParseAt: "2026-07-11T12:00:00Z", formatDrift: false,
  metricsCurrent: null, server: null, guilds: [],
  players: [{ uid: "ry", name: "RyFyShy", online: true, level: 40, guildId: null, guildName: null, firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-07-11T12:00:00Z", playtimeSec: 1 }],
  pals: [{ instanceId: "boss", characterId: "BOSS_GrassMammoth", displayName: "Mammorest", level: 38, isAlpha: true, isLucky: false, ownerUid: "ry", ownerName: "RyFyShy", ownerSource: "last_observed" }],
};

function interaction(options: Record<string, string | null>) {
  const editReply = vi.fn();
  return {
    value: {
      deferReply: vi.fn(), editReply,
      options: { getString: (name: string, required?: boolean) => {
        const value = options[name] ?? null;
        if (required && value === null) throw new Error("missing option");
        return value;
      } },
    },
    editReply,
  };
}

describe("rare and team commands", () => {
  it("shows boss species with a crown and last-observed provenance", async () => {
    const run = interaction({ player: null });
    await rareCommand.execute(run.value as never, { snapshots: { get: vi.fn().mockResolvedValue(snapshot) }, config: { serverLabel: "the server" } } as never);
    const embed = run.editReply.mock.calls[0]![0].embeds[0].toJSON();
    expect(embed.description).toContain("Mammorest** 👑");
    expect(embed.description).toContain("RyFyShy (last observed)");
    expect(embed.description).not.toContain("BOSS_");
  });

  it("builds a transparent combat heuristic from current roster and knowledge", async () => {
    const run = interaction({ purpose: "combat", player: null });
    const knowledge = {
      init: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => ({ data: {
        internalId: "GrassMammoth", name: "Mammorest", dexNumber: 90, isVariant: false,
        elements: ["Grass"], workSuitabilities: [{ id: "Deforest", name: "Lumbering", level: 2 }],
        hp: 150, attack: 85, defense: 90, rarity: 8, breedingPower: 300, learnset: [],
      } })),
    };
    await teamCommand.execute(run.value as never, { snapshots: { get: vi.fn().mockResolvedValue(snapshot) }, knowledge, config: { serverLabel: "the server" } } as never);
    const embed = run.editReply.mock.calls[0]![0].embeds[0].toJSON();
    expect(embed.title).toContain("Combat Party");
    expect(embed.description).toContain("Mammorest 👑");
    expect(embed.footer.text).toContain("Heuristic");
  });
});
