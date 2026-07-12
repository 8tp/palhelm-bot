import { describe, expect, it, vi } from "vitest";
import { compareCommand } from "../src/commands/compare.js";
import { leaderboardCommand } from "../src/commands/leaderboard.js";
import { whohasCommand } from "../src/commands/whohas.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";

const snapshot: WorldSnapshot = {
  capturedAt: "2026-07-10T12:00:00.000Z",
  formatDrift: false,
  metricsCurrent: null,
  server: null,
  lastParseAt: "2026-07-10T12:00:00.000Z",
  players: [
    {
      uid: "b",
      name: "Beta",
      online: false,
      level: 20,
      guildId: "guild-1",
      guildName: "Pals",
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-07-09T00:00:00Z",
      playtimeSec: 3_600,
      captureTotal: 120,
      uniquePalsCaptured: 40,
    },
    {
      uid: "a",
      name: "Alpha",
      online: true,
      level: 20,
      guildId: null,
      guildName: null,
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-07-10T00:00:00Z",
      playtimeSec: 7_200,
      captureTotal: 80,
      uniquePalsCaptured: 50,
    },
  ],
  pals: [
    {
      instanceId: "pal-1",
      characterId: "Anubis",
      displayName: "Anubis",
      level: 30,
      isAlpha: true,
      isLucky: false,
      ownerUid: "b",
      ownerName: "Beta",
      inParty: true,
    },
    {
      instanceId: "pal-2",
      characterId: "Anubis",
      displayName: "Anubis",
      level: 25,
      isAlpha: false,
      isLucky: true,
      ownerUid: "b",
      ownerName: "Beta",
    },
    {
      instanceId: "pal-3",
      characterId: "Lamball",
      displayName: "Lamball",
      level: 10,
      isAlpha: false,
      isLucky: false,
      ownerUid: "a",
      ownerName: "Alpha",
    },
  ],
  guilds: [
    {
      id: "guild-1",
      name: "Pals",
      adminUid: "b",
      memberCount: 1,
      members: [{ uid: "b", name: "Beta" }],
      bases: [],
    },
  ],
};

function harness(
  options: Record<string, string | null>,
  source: WorldSnapshot = snapshot,
  suppressDriftNotices = false,
) {
  // editReply resolves to a message stub so commands that attach a component
  // collector (leaderboard's category menu) can call createMessageComponentCollector.
  const editReply = vi.fn().mockResolvedValue({
    createMessageComponentCollector: () => ({ on: () => {} }),
  });
  const interaction = {
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
  const ctx = {
    snapshots: { get: vi.fn().mockResolvedValue(source) },
    config: { suppressDriftNotices, serverLabel: "the server" },
    observations: { trends: () => null },
  };
  return { interaction, ctx, editReply };
}

function description(editReply: ReturnType<typeof vi.fn>) {
  const payload = editReply.mock.calls[0]?.[0];
  return payload.embeds[0].toJSON().description as string;
}

describe("snapshot social commands", () => {
  it("orders leaderboard ties deterministically and labels current holdings", async () => {
    const { interaction, ctx, editReply } = harness({ category: "level" });
    await leaderboardCommand.execute(interaction as never, ctx as never);
    expect(description(editReply)).toMatch(/1\.\*\* Alpha — Lv 20[\s\S]*2\.\*\* Beta — Lv 20/);
    expect(ctx.snapshots.get).toHaveBeenCalledOnce();

    const pals = harness({ category: "pals" });
    await leaderboardCommand.execute(pals.interaction as never, pals.ctx as never);
    expect(pals.editReply.mock.calls[0]?.[0].embeds[0].toJSON().title).toContain(
      "Current pals",
    );

    const captures = harness({ category: "captures" });
    await leaderboardCommand.execute(captures.interaction as never, captures.ctx as never);
    expect(description(captures.editReply)).toMatch(/1\.\*\* Beta — 120 lifetime captures[\s\S]*2\.\*\* Alpha — 80 lifetime captures/);
  });

  it("compares two players from one snapshot", async () => {
    const { interaction, ctx, editReply } = harness({ "player-a": "a", "player-b": "b" });
    await compareCommand.execute(interaction as never, ctx as never);
    expect(description(editReply)).toContain("**Current pals** — 1 │ 2");
    expect(description(editReply)).toContain("**Highest pal** — Lv 10 │ Lv 30");
    expect(ctx.snapshots.get).toHaveBeenCalledOnce();
  });

  it("groups whohas results by current owner", async () => {
    const { interaction, ctx, editReply } = harness({ pal: "Anubis" });
    await whohasCommand.execute(interaction as never, ctx as never);
    expect(description(editReply)).toContain("2 currently owned across 1 player");
    expect(description(editReply)).toContain("**Beta** — 2 · best Lv 30 ⭐ 🍀 · 1 in party");
    expect(ctx.snapshots.get).toHaveBeenCalledOnce();
  });

  it("hides drift text when Discord drift warnings are suppressed", async () => {
    const drifted = { ...snapshot, formatDrift: true };
    const { interaction, ctx, editReply } = harness(
      { category: "level" },
      drifted,
      true,
    );
    await leaderboardCommand.execute(interaction as never, ctx as never);
    expect(description(editReply)).not.toContain("format drift");
  });
});
