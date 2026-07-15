import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { GoalService } from "../src/goals/service.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function snapshot(capturedAt: string, pals: WorldSnapshot["pals"] = []): WorldSnapshot {
  return {
    capturedAt, lastParseAt: capturedAt, formatDrift: false,
    players: [], pals, guilds: [], metricsCurrent: null, server: null,
  };
}

async function service() {
  const dir = await mkdtemp(join(tmpdir(), "goals-test-"));
  dirs.push(dir);
  const path = join(dir, "goals.json");
  const goals = new GoalService(path, () => new Date("2026-07-11T12:00:00Z"));
  await goals.init();
  return { goals, path };
}

describe("GoalService", () => {
  it("persists goals privately and completes only on a new matching instance", async () => {
    const { goals, path } = await service();
    const baseline = snapshot("2026-07-11T12:00:00Z", [{
      instanceId: "normal", characterId: "GrassMammoth", displayName: "Mammorest",
      level: 20, isAlpha: false, isLucky: false, ownerUid: "a", ownerName: "Alpha",
    }]);
    const goal = await goals.add({
      createdBy: "discord-1", createdByName: "Tester", speciesId: "GrassMammoth",
      speciesName: "Mammorest", variant: "boss", snapshot: baseline,
    });
    expect(goal.id).toBe("1");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await expect(goals.observe(baseline)).resolves.toEqual([]);
    const completed = await goals.observe(snapshot("2026-07-11T12:05:00Z", [...baseline.pals, {
      ...baseline.pals[0]!, instanceId: "boss", characterId: "BOSS_GrassMammoth",
      level: 38, isAlpha: true, ownerUid: "r", ownerName: "RyFyShy",
    }]));
    expect(completed).toMatchObject([{ goal: { id: "1", variant: "boss" }, pal: { ownerName: "RyFyShy", level: 38 } }]);
    expect(goals.list()).toEqual([]);
    expect(goals.nextPending()).toMatchObject({ goal: { id: "1" } });
    await goals.ackPending("1");
    expect(goals.nextPending()).toBeNull();

    const restarted = new GoalService(path);
    await restarted.init();
    expect(restarted.list()).toEqual([]);
  });

  it("rejects goals already satisfied and protects ownership on removal", async () => {
    const { goals } = await service();
    const current = snapshot("2026-07-11T12:00:00Z", [{
      instanceId: "lucky", characterId: "Anubis", displayName: "Anubis", level: 30,
      isAlpha: false, isLucky: true, ownerUid: "a", ownerName: "Alpha",
    }]);
    await expect(goals.add({
      createdBy: "u", createdByName: "User", speciesId: "Anubis", speciesName: "Anubis",
      variant: "lucky", snapshot: current,
    })).rejects.toThrow("already_observed");
    const goal = await goals.add({
      createdBy: "u", createdByName: "User", speciesId: "Anubis", speciesName: "Anubis",
      variant: "boss", snapshot: current,
    });
    await expect(goals.remove(goal.id, "other")).resolves.toBe(false);
    await expect(goals.remove(goal.id, "u")).resolves.toBe(true);
  });

  it("does not complete when a previously observed instance disappears and later returns", async () => {
    const { goals } = await service();
    const boss = {
      instanceId: "existing-boss", characterId: "BOSS_GrassMammoth", displayName: "Mammorest",
      level: 38, isAlpha: true, isLucky: false, ownerUid: "r", ownerName: "RyFyShy",
    };
    // Establish that the service has seen the instance, then let it disappear.
    await goals.observe(snapshot("2026-07-11T11:50:00Z", [boss]));
    await goals.observe(snapshot("2026-07-11T11:55:00Z", []));
    await goals.add({
      createdBy: "u", createdByName: "User", speciesId: "GrassMammoth",
      speciesName: "Mammorest", variant: "boss", snapshot: snapshot("2026-07-11T12:00:00Z", []),
    });

    await expect(goals.observe(snapshot("2026-07-11T12:05:00Z", [boss]))).resolves.toEqual([]);
    expect(goals.list()).toHaveLength(1);
  });

  it("persists a personal breeding plan and only completes for its scoped owner", async () => {
    const { goals, path } = await service();
    const empty = snapshot("2026-07-11T12:00:00Z");
    await goals.add({
      createdBy: "discord-1", createdByName: "Tester", speciesId: "Anubis", speciesName: "Anubis",
      variant: "any", snapshot: empty, ownerUid: "owner-a",
      breedingPlan: { passive: "Artisan", steps: [{ parent1: "A", parent2: "B", child: "Anubis" }] },
    });
    const restarted = new GoalService(path);
    await restarted.init();
    expect(restarted.list("discord-1")[0]).toMatchObject({ ownerUid: "owner-a", breedingPlan: { passive: "Artisan" } });

    const pal = { instanceId: "new", characterId: "Anubis", displayName: "Anubis", level: 1, isAlpha: false, isLucky: false, ownerUid: "friend", ownerName: "Friend" };
    await expect(restarted.observe(snapshot("2026-07-11T12:05:00Z", [pal]))).resolves.toEqual([]);
    await expect(restarted.observe(snapshot("2026-07-11T12:10:00Z", [{ ...pal, instanceId: "mine", ownerUid: "owner-a", ownerName: "Owner A" }]))).resolves.toHaveLength(1);
  });
});
