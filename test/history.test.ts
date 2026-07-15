import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ObservationTracker } from "../src/history/tracker.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";
import type { PlayerSummary, RosterPal } from "../src/types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function player(overrides: Partial<PlayerSummary> = {}): PlayerSummary {
  return {
    uid: "u1",
    name: "Luna",
    online: false,
    level: 9,
    guildId: null,
    guildName: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    playtimeSec: 23 * 3_600,
    ...overrides,
  };
}

function pal(overrides: Partial<RosterPal> = {}): RosterPal {
  return {
    instanceId: "p1",
    characterId: "SheepBall",
    displayName: "Lamball",
    level: 8,
    isAlpha: false,
    isLucky: false,
    ownerUid: "u1",
    ownerName: "Luna",
    canonical: true,
    ...overrides,
  };
}

function snapshot(at: string, overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    capturedAt: at,
    players: [player()],
    pals: [pal()],
    guilds: [],
    metricsCurrent: {
      fps: 60,
      fpsAvg: 60,
      frameTimeMs: 16.7,
      players: 1,
      maxPlayers: 16,
      day: 40,
      uptimeSec: 100,
      baseCamps: 1,
    },
    server: null,
    formatDrift: false,
    lastParseAt: at,
    ...overrides,
  };
}

async function tracker(): Promise<ObservationTracker> {
  const dir = await mkdtemp(join(tmpdir(), "palhelm-history-"));
  dirs.push(dir);
  return new ObservationTracker(join(dir, "state.json"), () => new Date("2026-07-10T12:00:00.000Z"));
}

async function driftTracker(): Promise<ObservationTracker> {
  const dir = await mkdtemp(join(tmpdir(), "palhelm-history-drift-"));
  dirs.push(dir);
  return new ObservationTracker(join(dir, "state.json"), {
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    allowFormatDrift: true,
  });
}

describe("ObservationTracker", () => {
  it("uses the first snapshot as a silent baseline", async () => {
    const history = await tracker();
    await expect(history.observe(snapshot("2026-07-10T10:00:00.000Z"))).resolves.toEqual([]);
  });

  it("detects crossed milestones and globally new Pal instances/species", async () => {
    const history = await tracker();
    await history.observe(snapshot("2026-07-10T10:00:00.000Z"));
    const events = await history.observe(snapshot("2026-07-10T10:05:00.000Z", {
      players: [player({ level: 21, playtimeSec: 25 * 3_600 })],
      pals: [
        pal(),
        pal({
          instanceId: "p2",
          characterId: "Anubis",
          displayName: "Anubis",
          isAlpha: true,
        }),
      ],
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "level", playerName: "Luna", value: 10 }),
      expect.objectContaining({ kind: "level", playerName: "Luna", value: 20 }),
      expect.objectContaining({ kind: "playtime", playerName: "Luna", value: 24 * 3_600 }),
      expect.objectContaining({ kind: "first_alpha", playerName: "Luna" }),
      expect.objectContaining({ kind: "first_species", playerName: "Luna", speciesName: "Anubis" }),
    ]));
  });

  it("does not call a transferred known rare Pal a first find", async () => {
    const history = await tracker();
    await history.observe(snapshot("2026-07-10T10:00:00.000Z", {
      players: [player(), player({ uid: "u2", name: "Player Two" })],
      pals: [pal({ ownerUid: "u2", ownerName: "Player Two", isLucky: true })],
    }));
    const events = await history.observe(snapshot("2026-07-10T10:05:00.000Z", {
      pals: [pal({ ownerUid: "u1", ownerName: "Luna", isLucky: true })],
    }));
    expect(events.some((event) => event.kind === "first_lucky")).toBe(false);
  });

  it("waits to announce a species until its owner can be attributed", async () => {
    const history = await tracker();
    await history.observe(snapshot("2026-07-10T10:00:00.000Z"));
    const ownerless = pal({
      instanceId: "p2",
      characterId: "Suzaku",
      displayName: "Suzaku",
      ownerUid: "",
      ownerName: "",
    });

    await expect(history.observe(snapshot("2026-07-10T10:05:00.000Z", {
      pals: [pal(), ownerless],
    }))).resolves.toEqual([]);
    expect(history.nextMilestoneBatch()).toBeNull();

    await expect(history.observe(snapshot("2026-07-10T10:10:00.000Z", {
      pals: [pal(), { ...ownerless, ownerUid: "u1", ownerName: "" }],
    }))).resolves.toContainEqual(expect.objectContaining({
      kind: "first_species",
      playerName: "Luna",
      speciesName: "Suzaku",
    }));
  });

  it("never announces a non-canonical save entity as a Pal species", async () => {
    const history = await tracker();
    await history.observe(snapshot("2026-07-10T10:00:00.000Z"));
    await expect(history.observe(snapshot("2026-07-10T10:05:00.000Z", {
      pals: [pal(), pal({
        instanceId: "npc-1",
        characterId: "Hunter_Rifle",
        displayName: "Aerodeus",
        canonical: false,
      })],
    }))).resolves.toEqual([]);
    expect(history.nextMilestoneBatch()).toBeNull();
  });

  it("suppresses diffs during format drift", async () => {
    const history = await tracker();
    await history.observe(snapshot("2026-07-10T10:00:00.000Z"));
    const events = await history.observe(snapshot("2026-07-10T10:05:00.000Z", {
      formatDrift: true,
      players: [player({ level: 50 })],
      pals: [],
    }));
    expect(events).toEqual([]);
  });

  it("waits for a healthy snapshot before establishing its baseline", async () => {
    const history = await tracker();
    await expect(history.observe(snapshot("2026-07-10T10:00:00.000Z", {
      formatDrift: true,
      pals: [],
    }))).resolves.toEqual([]);
    await expect(history.observe(snapshot("2026-07-10T10:05:00.000Z"))).resolves.toEqual([]);
    expect(history.nextMilestoneBatch()).toBeNull();
  });

  it("requires two consistent drifted snapshots before a silent trusted baseline", async () => {
    const history = await driftTracker();
    await expect(history.observe(snapshot("2026-07-10T10:00:00.000Z", {
      formatDrift: true,
    }))).resolves.toEqual([]);
    await expect(history.observe(snapshot("2026-07-10T10:05:00.000Z", {
      formatDrift: true,
      pals: [pal(), pal({ instanceId: "p2", characterId: "Anubis", displayName: "Anubis" })],
    }))).resolves.toEqual([]);

    expect(history.nextMilestoneBatch()).toBeNull();
    const events = await history.observe(snapshot("2026-07-10T10:10:00.000Z", {
      formatDrift: true,
      players: [player({ level: 10 })],
      pals: [pal(), pal({ instanceId: "p2", characterId: "Anubis", displayName: "Anubis" })],
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "level", playerName: "Luna", value: 10 }));
  });

  it("does not count the same cached drift snapshot as two confirmations", async () => {
    const history = await driftTracker();
    const cached = snapshot("2026-07-10T10:00:00.000Z", { formatDrift: true });
    await history.observe(cached);
    await history.observe(cached);
    await expect(history.prepareDigest("before-baseline", null)).resolves.toBeNull();

    await history.observe(snapshot("2026-07-10T10:05:00.000Z", { formatDrift: true }));
    await expect(history.prepareDigest("after-baseline", null)).resolves.not.toBeNull();
  });

  it("rejects empty and collapsed drift snapshots after trusted baselining", async () => {
    const history = await driftTracker();
    const manyPals = Array.from({ length: 10 }, (_, index) => pal({
      instanceId: `p${index}`,
      characterId: `Species${index}`,
      displayName: `Species ${index}`,
    }));
    await history.observe(snapshot("2026-07-10T10:00:00.000Z", { formatDrift: true, pals: manyPals }));
    await history.observe(snapshot("2026-07-10T10:05:00.000Z", { formatDrift: true, pals: manyPals }));

    await expect(history.observe(snapshot("2026-07-10T10:10:00.000Z", {
      formatDrift: true,
      players: [],
      pals: [],
    }))).resolves.toEqual([]);
    await expect(history.observe(snapshot("2026-07-10T10:15:00.000Z", {
      formatDrift: true,
      pals: [manyPals[0]!],
    }))).resolves.toEqual([]);
    expect(history.nextMilestoneBatch()).toBeNull();
  });

  it("requires two fresh drift confirmations after a tracker restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-history-restart-drift-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    const options = { allowFormatDrift: true, now: () => new Date("2026-07-10T12:00:00.000Z") };
    const first = new ObservationTracker(path, options);
    await first.observe(snapshot("2026-07-10T10:00:00.000Z"));
    const restarted = new ObservationTracker(path, options);

    await restarted.observe(snapshot("2026-07-10T10:05:00.000Z", {
      formatDrift: true,
      players: [player({ level: 10 })],
    }));
    expect(restarted.nextMilestoneBatch()).toBeNull();
    const accepted = await restarted.observe(snapshot("2026-07-10T10:10:00.000Z", {
      formatDrift: true,
      players: [player({ level: 10 })],
    }));
    expect(accepted).toContainEqual(expect.objectContaining({ kind: "level", playerName: "Luna", value: 10 }));
  });

  it("recovers its persistence queue after a filesystem failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-history-"));
    dirs.push(dir);
    const blocker = join(dir, "blocked");
    await writeFile(blocker, "not a directory");
    const history = new ObservationTracker(join(blocker, "state.json"));
    await expect(history.observe(snapshot("2026-07-10T10:00:00.000Z"))).rejects.toThrow();
    await unlink(blocker);
    await mkdir(blocker);
    await expect(history.observe(snapshot("2026-07-10T10:00:00.000Z"))).resolves.toEqual([]);
  });

  it("serializes an observation with a simultaneous SSE backup event", async () => {
    const history = await tracker();
    await history.observe(snapshot("2026-07-10T10:00:00.000Z"));
    await Promise.all([
      history.observe(snapshot("2026-07-10T10:05:00.000Z", {
        pals: [pal(), pal({ instanceId: "p2", characterId: "Anubis", displayName: "Anubis" })],
      })),
      history.recordPanelEvent({
        at: "2026-07-10T10:05:01.000Z",
        kind: "backup",
        message: "scheduled backup complete",
      }),
    ]);
    const pending = await history.prepareDigest("2026-07-10", snapshot("2026-07-10T10:05:00.000Z"));
    expect(pending?.digest).toMatchObject({ backups: 1, newPalInstances: 1 });
  });

  it("persists deduplication and produces a claimed digest once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-history-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    const first = new ObservationTracker(path, () => new Date("2026-07-10T12:00:00.000Z"));
    await first.observe(snapshot("2026-07-10T10:00:00.000Z"));
    await first.observe(snapshot("2026-07-10T10:05:00.000Z", {
      players: [player({ playtimeSec: 24 * 3_600 })],
      pals: [pal(), pal({ instanceId: "p2", characterId: "Anubis", displayName: "Anubis" })],
    }));

    const restarted = new ObservationTracker(path, () => new Date("2026-07-10T12:00:00.000Z"));
    await expect(restarted.observe(snapshot("2026-07-10T10:05:00.000Z"))).resolves.toEqual([]);
    expect(restarted.nextMilestoneBatch()).not.toBeNull();
    const pending = await restarted.prepareDigest("2026-07-10", snapshot("2026-07-10T10:05:00.000Z"));
    expect(pending?.digest).toMatchObject({ newPalInstances: 1, newSpecies: ["Anubis"], snapshots: 1 });
    await expect(restarted.prepareDigest("2026-07-10", null)).resolves.toEqual(pending);
    await restarted.ackDigest("2026-07-10");
    await expect(restarted.prepareDigest("2026-07-10", null)).resolves.toBeNull();
  });

  it("measures per-player trends over a trailing window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-history-trend-"));
    dirs.push(dir);
    let clock = Date.parse("2026-07-10T00:00:00.000Z");
    const history = new ObservationTracker(join(dir, "state.json"), {
      now: () => new Date(clock),
      historySampleIntervalMs: 1_000,
    });
    // Baseline anchor: Luna at level 9, 23h, one Pal.
    await history.observe(snapshot("2026-07-10T00:00:00.000Z"));

    clock = Date.parse("2026-07-18T00:00:00.000Z");
    const grown = snapshot("2026-07-18T00:00:00.000Z", {
      players: [player({ level: 15, playtimeSec: 30 * 3_600 })],
      pals: [pal(), pal({ instanceId: "p2", characterId: "Anubis", displayName: "Anubis" })],
    });
    await history.observe(grown);

    const week = history.trends(7 * 86_400_000, grown);
    expect(week?.fullWindow).toBe(true);
    expect(week?.players).toEqual([
      expect.objectContaining({ uid: "u1", levelGain: 6, playtimeGainSec: 7 * 3_600, palGain: 1, currentLevel: 15 }),
    ]);

    // A window longer than the recorded history is reported as partial.
    expect(history.trends(30 * 86_400_000, grown)?.fullWindow).toBe(false);
  });

  it("summarizes optional health measurements from the bounded history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-history-health-"));
    dirs.push(dir);
    let clock = Date.parse("2026-07-10T12:00:00.000Z");
    const history = new ObservationTracker(join(dir, "state.json"), {
      now: () => new Date(clock),
      historySampleIntervalMs: 1_000,
    });
    await history.observe(snapshot("2026-07-10T11:59:00.000Z", {
      metricsCurrent: { ...snapshot("x").metricsCurrent!, fps: 60, uptimeSec: 100 },
    }));
    await history.recordPanelEvent({ at: "2026-07-10T12:30:00.000Z", kind: "backup", message: "complete" });
    clock = Date.parse("2026-07-10T13:00:00.000Z");
    await history.observe(snapshot("2026-07-10T12:58:00.000Z", {
      metricsCurrent: { ...snapshot("x").metricsCurrent!, fps: 30, uptimeSec: 3_700 },
    }));

    expect(history.healthHistorySummary()).toEqual({
      startedAt: "2026-07-10T12:00:00.000Z",
      endedAt: "2026-07-10T13:00:00.000Z",
      sampleCount: 2,
      telemetrySampleCount: 2,
      averageFps: 45,
      lowFps: 30,
      latestSaveAgeSec: 120,
      latestBackupAgeSec: 1_800,
      latestUptimeSec: 3_700,
    });
  });

  it("loads older version-two history samples that have no health fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-history-health-compat-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    const first = new ObservationTracker(path, () => new Date("2026-07-10T12:00:00.000Z"));
    await first.observe(snapshot("2026-07-10T11:59:00.000Z"));
    const stored = JSON.parse(await readFile(path, "utf8")) as { history: Array<Record<string, unknown>> };
    for (const sample of stored.history) {
      delete sample.fps;
      delete sample.saveAgeSec;
      delete sample.backupAgeSec;
      delete sample.uptimeSec;
    }
    await writeFile(path, JSON.stringify(stored));

    const restarted = new ObservationTracker(path);
    await restarted.init();
    expect(restarted.healthHistorySummary()).toBeNull();
  });

  it("persists observed record-holder changes without duplicate announcements", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-history-records-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    const first = new ObservationTracker(path, () => new Date("2026-07-10T12:00:00.000Z"));
    const initialPlayers = [player({ level: 31 }), player({ uid: "u2", name: "Player Two", level: 30, playtimeSec: 10 * 3_600 })];
    await first.observe(snapshot("2026-07-10T10:00:00.000Z", { players: initialPlayers }));

    // The incumbent improving silently must raise the persisted record value.
    expect((await first.observe(snapshot("2026-07-10T10:05:00.000Z", {
      players: [player({ level: 33 }), initialPlayers[1]!],
    }))).filter((event) => event.kind === "record")).toEqual([]);
    expect((await first.observe(snapshot("2026-07-10T10:10:00.000Z", {
      players: [player({ level: 33 }), player({ uid: "u2", name: "Player Two", level: 32, playtimeSec: 10 * 3_600 })],
    }))).filter((event) => event.kind === "record")).toEqual([]);

    const changes = (await first.observe(snapshot("2026-07-10T10:15:00.000Z", {
      players: [player({ level: 33 }), player({ uid: "u2", name: "Player Two", level: 34, playtimeSec: 10 * 3_600 })],
    }))).filter((event) => event.kind === "record");
    expect(changes).toEqual([expect.objectContaining({
      playerName: "Player Two",
      previousPlayerName: "Luna",
      recordLabel: "highest player level",
      recordDetail: "Lv 34",
      confidence: "observed",
      trackingStartedAt: "2026-07-10T12:00:00.000Z",
      observedAt: "2026-07-10T10:15:00.000Z",
    })]);
    expect(first.recordHistory()).toEqual([expect.objectContaining({ playerName: "Player Two", previousPlayerName: "Luna" })]);
    const recap = await first.prepareDigest("2026-07-10", snapshot("2026-07-10T10:15:00.000Z"));
    expect(recap?.digest.milestones).toContain("Player Two passed Luna for highest player level (Lv 34) · observed record");
    await first.ackDigest("2026-07-10");
    await first.ackMilestoneBatch("2026-07-10T10:15:00.000Z");

    const restarted = new ObservationTracker(path, () => new Date("2026-07-10T12:20:00.000Z"));
    const repeated = await restarted.observe(snapshot("2026-07-10T10:20:00.000Z", {
      players: [player({ level: 33 }), player({ uid: "u2", name: "Player Two", level: 34, playtimeSec: 10 * 3_600 })],
    }));
    expect(repeated.filter((event) => event.kind === "record")).toEqual([]);
    expect(restarted.recordHistory()).toHaveLength(1);
  });
});
