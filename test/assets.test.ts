import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetCache } from "../src/palhelm/assets.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("binary asset cache", () => {
  it("normalizes boss-prefixed Pal IDs for milestones, /box, and /pals", async () => {
    const binary = vi.fn().mockResolvedValue({ buffer: Buffer.from("icon"), contentType: "image/webp" });
    const cache = new AssetCache({ binary } as never);

    await cache.palIcon("BOSS_Gorilla_Ground");
    await cache.palIcon("Gorilla_Ground");

    expect(binary).toHaveBeenCalledTimes(1);
    expect(binary).toHaveBeenCalledWith("/api/v1/paldeck/icon/gorilla_ground");
  });

  it("uses base art for cosmetic/tower variants and preserves Hawk's exact portrait", async () => {
    const binary = vi.fn(async (path: string) => path.includes("boss_hunter_rifle")
      ? { buffer: Buffer.from("hawk"), contentType: "image/png" }
      : { buffer: Buffer.from("pal"), contentType: "image/webp" });
    const cache = new AssetCache({ binary } as never);

    await cache.palIcon("PlantSlime_Flower");
    await cache.palIcon("GrassPanda_Electric_Tower");
    await cache.palIcon("BOSS_Hunter_Rifle");

    expect(binary).toHaveBeenCalledWith("/api/v1/paldeck/icon/plantslime");
    expect(binary).toHaveBeenCalledWith("/api/v1/paldeck/icon/grasspanda_electric");
    expect(binary).toHaveBeenCalledWith("/api/v1/paldeck/icon/boss_hunter_rifle");
  });

  it("retries remembered 404s after a bounded negative-cache TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T03:00:00Z"));
    const binary = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ buffer: Buffer.from("new icon"), contentType: "image/webp" });
    const cache = new AssetCache({ binary } as never);

    await expect(cache.palIcon("NewPal")).resolves.toBeNull();
    await expect(cache.palIcon("NewPal")).resolves.toBeNull();
    expect(binary).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(cache.palIcon("NewPal")).resolves.toMatchObject({ contentType: "image/webp" });
    expect(binary).toHaveBeenCalledTimes(2);
  });
});
