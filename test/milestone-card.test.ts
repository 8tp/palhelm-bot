import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderMilestoneCard } from "../src/history/milestoneCard.js";

const avatar = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <rect width="200" height="200" fill="#314d68"/><circle cx="100" cy="76" r="42" fill="#f3bd62"/>
  <path d="M35 200c5-60 125-60 130 0" fill="#75d9dc"/>
</svg>`);
const pal = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <path d="M25 160L48 52l42 30 52-45 35 123z" fill="#f3bd62" stroke="#fff" stroke-width="8"/>
</svg>`);

describe("milestone cards", () => {
  it("composites player and Pal imagery into a bounded Discord JPEG", async () => {
    const assets = {
      playerAvatar: async () => ({ buffer: avatar, contentType: "image/svg+xml" }),
      palIcon: async () => ({ buffer: pal, contentType: "image/svg+xml" }),
    };
    const output = await renderMilestoneCard({
      kind: "first_species",
      playerUid: "u1",
      playerName: "Luna & Friends",
      characterId: "Suzaku",
      speciesName: "Suzaku",
    }, assets as never, "Valley Squad");
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 1200, height: 675 });
    expect(output.byteLength).toBeLessThan(2_000_000);
  });

  it("renders a level badge and avatar fallback when panel assets are absent", async () => {
    const assets = {
      playerAvatar: async () => null,
      palIcon: async () => null,
    };
    const output = await renderMilestoneCard({
      kind: "level",
      playerUid: "u1",
      playerName: "Hunter",
      value: 40,
    }, assets as never, "Valley Squad");
    expect((await sharp(output).metadata()).format).toBe("jpeg");
  });
});
