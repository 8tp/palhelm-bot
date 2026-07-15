import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LOCATION_CACHE_SCHEMA_VERSION, PalLocationService } from "../src/knowledge/locations.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Pal location cache", () => {
  it("loads exact attributed encounter rows and fails closed on malformed data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pal-locations-"));
    dirs.push(dir);
    const path = join(dir, "locations.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: LOCATION_CACHE_SCHEMA_VERSION, generatedAt: "2026-07-15T00:00:00Z",
      source: { label: "Wiki", url: "https://palworld.wiki.gg/", license: "CC BY-SA 4.0", query: "LocationEntity" },
      rows: [{ locationName: "Twilight Dunes", entityName: "Anubis", entityType: "pal", variantType: "Alpha", level: 47, coords: { x: -130, y: -96 }, note: "" }],
    }));
    const service = new PalLocationService(path);
    await service.init();
    expect(service.status()).toMatchObject({ available: true, rowCount: 1, license: "CC BY-SA 4.0" });
    expect(service.search("anubis")[0]?.coords).toEqual({ x: -130, y: -96 });

    await writeFile(path, "{broken");
    const broken = new PalLocationService(path);
    await broken.init();
    expect(broken.status().available).toBe(false);
  });
});
