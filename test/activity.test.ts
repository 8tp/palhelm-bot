import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTracker, activitySeedsFromEvents } from "../src/history/activity.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function snapshot(at: string, online: boolean): WorldSnapshot {
  return {
    capturedAt: at, lastParseAt: at, formatDrift: false,
    players: [{ uid: "u", name: "Hunter", online, level: 1, guildId: null, guildName: null, firstSeenAt: at, lastSeenAt: at, playtimeSec: 0 }],
    pals: [], guilds: [], metricsCurrent: null, server: { name: "s", description: "", version: "1", state: "running", uptimeSec: 1 },
  };
}

describe("ActivityTracker", () => {
  it("preserves an online session start across a bot restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-activity-"));
    dirs.push(dir);
    const path = join(dir, "activity.json");
    const start = Date.parse("2026-07-11T12:00:00Z");
    const first = new ActivityTracker(path);
    await expect(first.observe(snapshot("2026-07-11T12:00:00Z", true), start)).resolves.toEqual([]);

    const restarted = new ActivityTracker(path);
    await expect(restarted.observe(snapshot("2026-07-11T21:55:00Z", true), start + 9 * 3_600_000 + 55 * 60_000)).resolves.toEqual([]);
    await expect(restarted.observe(snapshot("2026-07-11T22:00:00Z", false), start + 10 * 3_600_000))
      .resolves.toMatchObject([{ kind: "leave", name: "Hunter", durationSec: 36_000 }]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, onlineSince: {} });
  });

  it("silently reconciles players who left while the bot was stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-activity-"));
    dirs.push(dir);
    const path = join(dir, "activity.json");
    const first = new ActivityTracker(path);
    await first.observe(snapshot("2026-07-11T12:00:00Z", true), 1_000);
    const restarted = new ActivityTracker(path);
    await expect(restarted.observe(snapshot("2026-07-11T13:00:00Z", false), 3_601_000)).resolves.toEqual([]);
  });

  it("backfills a pre-feature online session from the latest bounded join event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-activity-"));
    dirs.push(dir);
    const path = join(dir, "activity.json");
    const start = Date.parse("2026-07-11T12:00:00Z");
    const seeds = activitySeedsFromEvents([
      { at: "2026-07-11T11:00:00Z", kind: "join", message: "old joined", meta: { uid: "U" } },
      { at: "2026-07-11T11:30:00Z", kind: "leave", message: "old left", meta: { uid: "u" } },
      { at: "2026-07-11T12:00:00Z", kind: "join", message: "Hunter joined", meta: { uid: "U" } },
    ]);
    const tracker = new ActivityTracker(path);
    await tracker.observe(snapshot("2026-07-11T21:55:00Z", true), start + 9 * 3_600_000 + 55 * 60_000, seeds);
    await expect(tracker.observe(snapshot("2026-07-11T22:00:00Z", false), start + 10 * 3_600_000))
      .resolves.toMatchObject([{ durationSec: 36_000 }]);
  });

  it("repairs a newer persisted approximation with an older authoritative hint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-activity-"));
    dirs.push(dir);
    const path = join(dir, "activity.json");
    const start = Date.parse("2026-07-11T12:00:00Z");
    const tracker = new ActivityTracker(path);
    await tracker.observe(snapshot("2026-07-11T16:00:00Z", true), start + 4 * 3_600_000);
    const restarted = new ActivityTracker(path);
    await restarted.observe(snapshot("2026-07-11T21:55:00Z", true), start + 9 * 3_600_000 + 55 * 60_000, new Map([["u", start]]));
    await expect(restarted.observe(snapshot("2026-07-11T22:00:00Z", false), start + 10 * 3_600_000))
      .resolves.toMatchObject([{ durationSec: 36_000 }]);
  });
});
