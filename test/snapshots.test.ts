import { describe, expect, it, vi } from "vitest";
import type { IntegrationClient } from "../src/palhelm/integration.js";
import { ApiError } from "../src/palhelm/integration.js";
import { SnapshotService } from "../src/snapshots/service.js";

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    players: vi.fn(async () => ({
      data: [{ uid: "p1", name: "Ada", online: true }],
      lastParseAt: "2026-07-10T10:00:00.000Z",
      formatDrift: false,
    })),
    pals: vi.fn(async () => ({
      data: [{ instanceId: "pal-1", ownerUid: "p1", displayName: "Lamball" }],
      lastParseAt: "2026-07-10T10:00:00.000Z",
      formatDrift: true,
    })),
    guilds: vi.fn(async () => ({
      data: [{ id: "g1", name: "Friends" }],
      lastParseAt: "2026-07-10T10:00:00.000Z",
      formatDrift: false,
    })),
    metricsCurrent: vi.fn(async () => ({ data: { fps: 60, players: 1 } })),
    server: vi.fn(async () => ({
      data: { name: "Test Server", state: "running" },
      formatDrift: false,
    })),
    worldSummary: vi.fn(async () => ({
      data: {
        state: "ready", capturedAt: "2026-07-10T10:01:00.000Z", lastAttemptAt: "2026-07-10T10:01:00.000Z",
        fps: 59, fpsAvg: 59,
        counts: { players: 1, partyPals: 1, basePals: 2, wildPals: 0, npcs: 0, palBoxes: 1, unknown: 0 },
      },
    })),
    worldWorkers: vi.fn(async () => ({
      data: {
        state: "ready", capturedAt: "2026-07-10T10:01:00.000Z", workers: [],
      },
    })),
    ...overrides,
  } as unknown as IntegrationClient;
}

describe("SnapshotService", () => {
  it("aggregates the public endpoints and ORs save drift", async () => {
    const service = new SnapshotService(fakeClient(), {
      now: () => Date.parse("2026-07-10T10:01:00.000Z"),
    });

    const snapshot = await service.get();

    expect(snapshot.players[0]).toMatchObject({ uid: "p1" });
    expect(snapshot.pals[0]).toMatchObject({ instanceId: "pal-1" });
    expect(snapshot.guilds[0]).toMatchObject({ id: "g1" });
    expect(snapshot.metricsCurrent).toMatchObject({ fps: 60 });
    expect(snapshot.server).toMatchObject({ name: "Test Server" });
    expect(snapshot.worldSummary).toMatchObject({ state: "ready", counts: { basePals: 2 } });
    expect(snapshot.liveWorkers).toMatchObject({ state: "ready", workers: [] });
    expect(snapshot.formatDrift).toBe(true);
    expect(snapshot.lastParseAt).toBe("2026-07-10T10:00:00.000Z");
    expect(service.peek()).toBe(snapshot);
  });

  it("annotates exact canonical Pal IDs and rejects friendly-looking placeholders", async () => {
    const service = new SnapshotService(fakeClient({
      pals: vi.fn(async () => ({
        data: [
          { instanceId: "known", characterId: "Anubis", displayName: "Aerodeus" },
          { instanceId: "npc", characterId: "Hunter_Rifle", displayName: "Hunter Rifle" },
        ],
        formatDrift: false,
      })),
    }), {
      resolvePalName: (id) => id === "Anubis" ? "Anubis" : "Hunter Rifle",
      isCanonicalPal: (id) => id === "Anubis",
    });

    const pals = (await service.get()).pals;
    expect(pals[0]).toMatchObject({ displayName: "Anubis", canonical: true });
    expect(pals[1]).toMatchObject({ displayName: "Hunter Rifle", canonical: false });
  });

  it("coalesces concurrent cold refreshes and serves a fresh cached snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const players = vi.fn(async () => {
      await gate;
      return { data: [], formatDrift: false };
    });
    const client = fakeClient({ players });
    const service = new SnapshotService(client);

    const first = service.get();
    const second = service.get();
    release();
    const [a, b] = await Promise.all([first, second]);
    const third = await service.get();

    expect(a).toBe(b);
    expect(third).toBe(a);
    expect(players).toHaveBeenCalledTimes(1);
  });

  it("does not commit a partial core refresh and returns the last-good snapshot", async () => {
    let now = Date.parse("2026-07-10T10:01:00.000Z");
    const pals = vi.fn()
      .mockResolvedValueOnce({ data: [], formatDrift: false })
      .mockRejectedValueOnce(new Error("temporary failure"));
    const players = vi.fn()
      .mockResolvedValueOnce({ data: [{ uid: "old" }], formatDrift: false })
      .mockResolvedValueOnce({ data: [{ uid: "new" }], formatDrift: false });
    const service = new SnapshotService(fakeClient({ players, pals }), {
      maxAgeMs: 1,
      now: () => now,
    });
    const original = await service.get();
    now += 2;

    const afterFailure = await service.get();

    expect(afterFailure).toBe(original);
    expect(service.peek()?.players[0]).toMatchObject({ uid: "old" });
  });

  it("marks failed metrics as unavailable while retaining display-only server state", async () => {
    let now = Date.parse("2026-07-10T10:01:00.000Z");
    const metricsCurrent = vi.fn()
      .mockResolvedValueOnce({ data: { fps: 60 } })
      .mockRejectedValueOnce(new Error("metrics unavailable"));
    const server = vi.fn()
      .mockResolvedValueOnce({ data: { name: "Test Server", state: "running" } })
      .mockRejectedValueOnce(new Error("server unavailable"));
    const service = new SnapshotService(fakeClient({ metricsCurrent, server }), {
      maxAgeMs: 1,
      now: () => now,
    });
    await service.get();
    now += 2;

    const refreshed = await service.get();

    expect(refreshed.metricsCurrent).toBeNull();
    expect(refreshed.server).toMatchObject({ name: "Test Server" });
  });

  it("rejects core responses from different save parse generations", async () => {
    const service = new SnapshotService(fakeClient({
      pals: vi.fn(async () => ({
        data: [],
        lastParseAt: "2026-07-10T10:00:01.000Z",
        formatDrift: false,
      })),
    }));
    await expect(service.get()).rejects.toThrow("different save parse generations");
    expect(service.peek()).toBeNull();
  });

  it("allows optional telemetry to be null on the first snapshot", async () => {
    const unavailable = vi.fn(async () => { throw new Error("offline"); });
    const service = new SnapshotService(fakeClient({
      metricsCurrent: unavailable,
      server: unavailable,
      worldSummary: unavailable,
      worldWorkers: unavailable,
    }));

    const snapshot = await service.get();

    expect(snapshot.metricsCurrent).toBeNull();
    expect(snapshot.server).toBeNull();
    expect(snapshot.worldSummary).toBeNull();
    expect(snapshot.liveWorkers).toBeNull();
  });

  it("marks a transient last-good live sample stale and expires it by capture time", async () => {
    let now = Date.parse("2026-07-10T10:01:00.000Z");
    const worldSummary = vi.fn()
      .mockResolvedValueOnce({
        data: {
          state: "ready", capturedAt: new Date(now).toISOString(), lastAttemptAt: new Date(now).toISOString(),
          fps: 60, fpsAvg: 60,
          counts: { players: 1, partyPals: 0, basePals: 1, wildPals: 0, npcs: 0, palBoxes: 1, unknown: 0 },
        },
      })
      .mockRejectedValue(new Error("temporary live-data outage"));
    const service = new SnapshotService(fakeClient({ worldSummary }), {
      maxAgeMs: 1,
      liveDataMaxAgeMs: 60_000,
      now: () => now,
    });

    expect((await service.get()).worldSummary?.state).toBe("ready");
    now += 2;
    expect((await service.get()).worldSummary?.state).toBe("stale");
    now += 60_000;
    expect((await service.get()).worldSummary).toBeNull();
  });

  it("clears last-good live data immediately on a terminal API failure", async () => {
    let now = Date.parse("2026-07-10T10:01:00.000Z");
    const worldWorkers = vi.fn()
      .mockResolvedValueOnce({
        data: { state: "ready", capturedAt: new Date(now).toISOString(), workers: [] },
      })
      .mockRejectedValueOnce(new ApiError(403, "forbidden", "forbidden"));
    const service = new SnapshotService(fakeClient({ worldWorkers }), {
      maxAgeMs: 1,
      liveDataMaxAgeMs: 60_000,
      now: () => now,
    });

    expect((await service.get()).liveWorkers?.state).toBe("ready");
    now += 2;
    expect((await service.get()).liveWorkers).toBeNull();
  });

  it("rejects an already-expired live sample even when the request succeeds", async () => {
    const now = Date.parse("2026-07-10T10:01:00.000Z");
    const worldWorkers = vi.fn(async () => ({
      data: {
        state: "ready",
        capturedAt: new Date(now - 60_001).toISOString(),
        workers: [],
      },
    }));
    const service = new SnapshotService(fakeClient({ worldWorkers }), {
      liveDataMaxAgeMs: 60_000,
      now: () => now,
    });

    expect((await service.get()).liveWorkers).toBeNull();
  });
});
