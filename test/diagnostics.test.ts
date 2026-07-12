import { describe, expect, it, vi } from "vitest";
import { diagnosticsCommand } from "../src/commands/diagnostics.js";

function harness(snapshot: unknown = {
  capturedAt: new Date().toISOString(),
  lastParseAt: new Date().toISOString(),
  formatDrift: false,
  players: [{ online: true }, { online: false }],
  pals: [{}, {}],
  guilds: [{}],
  metricsCurrent: { maxPlayers: 16 },
  server: { state: "running" },
}) {
  const editReply = vi.fn();
  const interaction = { deferReply: vi.fn(), editReply };
  const ctx = {
    snapshots: { peek: vi.fn(() => snapshot), get: vi.fn() },
    knowledge: {
      status: vi.fn(() => ({
        ready: true,
        palCount: 306,
        breedingCombinationCount: 12_345,
        metadata: {
          schemaVersion: 2,
          generatedAt: "2026-07-11T12:00:00.000Z",
          sources: [{}, {}],
        },
      })),
    },
    observations: {
      trackingStartedAt: vi.fn((): string | null => "2026-07-01T12:00:00.000Z"),
      lastBackupAt: vi.fn(() => "2026-07-11T11:00:00.000Z"),
      nextMilestoneBatch: vi.fn(() => null),
      nextPendingDigest: vi.fn(() => null),
      healthHistorySummary: vi.fn(() => ({
        startedAt: "2026-07-11T06:00:00.000Z",
        endedAt: "2026-07-11T12:00:00.000Z",
        sampleCount: 3,
        telemetrySampleCount: 3,
        averageFps: 58.25,
        lowFps: 51.5,
        latestSaveAgeSec: 30,
        latestBackupAgeSec: 3_600,
        latestUptimeSec: 86_400,
      })),
    },
    openRouter: {},
    webSearch: {},
    config: {
      openRouterModel: "example/model",
      aiDailyRequestLimit: 100,
      aiCooldownSec: 30,
      milestonesEnabled: true,
      milestonesChannelId: null,
      digestEnabled: true,
      digestWeekday: 0,
      digestHour: 18,
      healthAlertsEnabled: true,
      activityChannelId: "configured",
    },
  };
  return { interaction, ctx, editReply };
}

describe("diagnostics command", () => {
  it("is admin-only, ephemeral, and never refreshes the snapshot", async () => {
    const { interaction, ctx } = harness();
    expect(diagnosticsCommand.adminOnly).toBe(true);
    await diagnosticsCommand.execute(interaction as never, ctx as never);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(ctx.snapshots.peek).toHaveBeenCalledOnce();
    expect(ctx.snapshots.get).not.toHaveBeenCalled();
  });

  it("renders useful status without exposing configured identifiers or URLs", async () => {
    const { interaction, ctx, editReply } = harness();
    await diagnosticsCommand.execute(interaction as never, ctx as never);
    const body = JSON.stringify(editReply.mock.calls[0]![0].embeds[0].toJSON());
    expect(body).toContain("306 pals");
    expect(body).toContain("12,345 breeding combinations");
    expect(body).toContain("1/16 online");
    expect(body).toContain("AI enabled");
    expect(body).toContain("Palworld web search enabled");
    expect(body).toContain("3 samples over 6h");
    expect(body).toContain("FPS 58.3 avg");
    expect(body).not.toContain("http");
  });

  it("describes caches that are not ready without making a network call", async () => {
    const { interaction, ctx, editReply } = harness(null);
    ctx.knowledge.status.mockReturnValue({
      ready: false,
      palCount: 0,
      breedingCombinationCount: 0,
      metadata: null,
    } as never);
    ctx.openRouter = null as never;
    ctx.webSearch = null as never;
    ctx.observations.trackingStartedAt.mockReturnValue(null);
    await diagnosticsCommand.execute(interaction as never, ctx as never);
    const body = JSON.stringify(editReply.mock.calls[0]![0].embeds[0].toJSON());
    expect(body).toContain("first background snapshot has not completed");
    expect(body).toContain("knowledge commands will degrade safely");
    expect(body).toContain("AI disabled");
    expect(ctx.snapshots.get).not.toHaveBeenCalled();
  });
});
