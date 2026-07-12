import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PlayerLinkService } from "../src/identity/playerLinks.js";

describe("PlayerLinkService", () => {
  it("self-claims only unclaimed players and persists relinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-links-"));
    const path = join(dir, "player-links.json");
    const service = new PlayerLinkService(path, () => new Date("2026-07-12T12:00:00Z"));
    await service.init();
    await service.claim({ guildId: "g", discordUserId: "d1", playerUid: "p1", playerName: "Hunter" });
    await expect(service.claim({ guildId: "g", discordUserId: "d2", playerUid: "p1", playerName: "Hunter" }))
      .rejects.toThrow("player_claimed");
    await service.claim({ guildId: "g", discordUserId: "d1", playerUid: "p2", playerName: "Ryfyshy" });
    expect(service.get("g", "d1")).toMatchObject({ playerUid: "p2", method: "self" });
    expect(service.getByPlayer("g", "p1")).toBeNull();

    const reopened = new PlayerLinkService(path);
    await reopened.init();
    expect(reopened.get("g", "d1")?.playerName).toBe("Ryfyshy");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("lets admins replace either side and clear the assignment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "palhelm-links-"));
    const service = new PlayerLinkService(join(dir, "links.json"));
    await service.init();
    await service.claim({ guildId: "g", discordUserId: "d1", playerUid: "p1", playerName: "Hunter" });
    const assigned = await service.assign({
      guildId: "g", discordUserId: "d2", playerUid: "p1", playerName: "Hunter", linkedBy: "admin",
    });
    expect(assigned).toMatchObject({ discordUserId: "d2", method: "admin", linkedBy: "admin" });
    expect(service.get("g", "d1")).toBeNull();
    expect(await service.unlink("g", "d2")).toMatchObject({ playerUid: "p1" });
    expect(service.list("g")).toEqual([]);
  });
});
