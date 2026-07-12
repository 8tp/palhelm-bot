import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { HealthWatch } from "../src/health/watch.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";

function snapshot(id: number, fps: number, lastParseAt = "2026-07-11T12:00:00Z"): WorldSnapshot {
  return {
    capturedAt: `2026-07-11T12:${String(id).padStart(2, "0")}:00Z`,
    lastParseAt, formatDrift: false, players: [], pals: [], guilds: [], server: null,
    metricsCurrent: { fps, fpsAvg: fps, frameTimeMs: 1_000 / fps, players: 0, maxPlayers: 16, day: 1, uptimeSec: 1, baseCamps: 0 },
  };
}

describe("HealthWatch", () => {
  it("uses fresh-snapshot hysteresis for low FPS and recovery", async () => {
    const watch = new HealthWatch({ now: () => Date.parse("2026-07-11T12:05:00Z") });
    expect(await watch.observe(snapshot(1, 30))).toEqual([]);
    expect(await watch.observe(snapshot(1, 30))).toEqual([]);
    expect(await watch.observe(snapshot(2, 35))).toMatchObject([{ kind: "low_fps" }]);
    expect(await watch.observe(snapshot(3, 45))).toEqual([]);
    expect(await watch.observe(snapshot(4, 55))).toEqual([]);
    expect(await watch.observe(snapshot(5, 60))).toMatchObject([{ kind: "fps_recovered" }]);
  });

  it("announces stale save state once and then recovery", async () => {
    let now = Date.parse("2026-07-11T12:30:00Z");
    const watch = new HealthWatch({ now: () => now, staleAfterMs: 10 * 60_000 });
    expect(await watch.observe(snapshot(1, 60))).toMatchObject([{ kind: "save_stale" }]);
    expect(await watch.observe(snapshot(2, 60))).toEqual([]);
    now = Date.parse("2026-07-11T12:31:00Z");
    expect(await watch.observe(snapshot(3, 60, "2026-07-11T12:30:30Z"))).toMatchObject([{ kind: "save_recovered" }]);
  });

  it("reports overdue backups only after a backup timestamp is known", async () => {
    let now = Date.parse("2026-07-12T18:00:00Z");
    const watch = new HealthWatch({ now: () => now, backupOverdueMs: 24 * 60 * 60_000 });
    expect(await watch.observe(snapshot(1, 60, "2026-07-12T17:59:00Z"), null)).toEqual([]);
    expect(await watch.observe(snapshot(2, 60, "2026-07-12T17:59:00Z"), "2026-07-11T12:00:00Z"))
      .toMatchObject([{ kind: "backup_overdue" }]);
    now = Date.parse("2026-07-12T18:05:00Z");
    expect(await watch.observe(snapshot(3, 60, "2026-07-12T18:04:00Z"), "2026-07-12T18:04:30Z"))
      .toMatchObject([{ kind: "backup_recovered" }]);
  });

  it("continues an active alert and its recovery hysteresis after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-health-"));
    const statePath = join(dir, "health.json");
    const options = { statePath, now: () => Date.parse("2026-07-11T12:05:00Z") };
    const first = new HealthWatch(options);
    expect(await first.observe(snapshot(1, 30))).toEqual([]);
    expect(await first.observe(snapshot(2, 30))).toMatchObject([{ kind: "low_fps" }]);

    const restarted = new HealthWatch(options);
    expect(await restarted.observe(snapshot(2, 30))).toEqual([]);
    expect(await restarted.observe(snapshot(3, 55))).toEqual([]);
    expect(await restarted.observe(snapshot(4, 60))).toMatchObject([{ kind: "fps_recovered" }]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      version: 1,
      lowFpsActive: false,
      lastCapturedAt: snapshot(4, 60).capturedAt,
    });
  });

  it("loads partial version-one state with backward-compatible defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-health-"));
    const statePath = join(dir, "health.json");
    await writeFile(statePath, JSON.stringify({ version: 1, staleActive: true }));
    const watch = new HealthWatch({ statePath, now: () => Date.parse("2026-07-11T12:05:00Z") });
    expect(await watch.observe(snapshot(1, 60))).toMatchObject([{ kind: "save_recovered" }]);
  });
});
