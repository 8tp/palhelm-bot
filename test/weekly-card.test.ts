import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderWeeklyDigestCard } from "../src/history/weeklyCard.js";

describe("weekly digest card", () => {
  it("renders bounded multi-stat recap art with optional Pal icons", async () => {
    const icon = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><circle cx="80" cy="80" r="70" fill="#f3bd62"/></svg>`);
    const output = await renderWeeklyDigestCard({
      startedAt: "2026-07-08T12:00:00Z", endedAt: "2026-07-15T12:00:00Z",
      activePlayers: ["Player One", "Luna"], playtimeDeltaSec: 18 * 3_600,
      newPalInstances: 12, newSpecies: ["Anubis"], newAlphas: 2, newLuckies: 1,
      milestones: ["Player One reached Lv 40"], averageFps: 58.4, lowFps: 52,
      firstDay: 250, lastDay: 256, backups: 20, snapshots: 900,
    }, "Example Pals", [icon]);
    expect(await sharp(output).metadata()).toMatchObject({ format: "jpeg", width: 1200, height: 675 });
    expect(output.byteLength).toBeLessThan(2_000_000);
  });
});
