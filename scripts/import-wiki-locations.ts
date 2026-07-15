import "dotenv/config";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LOCATION_CACHE_SCHEMA_VERSION, type PalLocationCache, type PalLocationRow } from "../src/knowledge/locations.js";
import { cleanWikitext } from "../src/knowledge/wikitext.js";

const API = "https://palworld.wiki.gg/api.php";
const SOURCE = "https://palworld.wiki.gg/wiki/Template:Entity_Location_Spawn";
const OUTPUT = resolve(process.argv[2] ?? process.env.BOT_DATA_DIR ?? "data", process.argv[2] ? "" : "pal-locations.json");
const USER_AGENT = "Palhelm-Discord-Bot/0.1 (personal server field guide; attributed local cache)";
const rows: PalLocationRow[] = [];

for (let offset = 0; offset < 100_000; offset += 500) {
  const url = new URL(API);
  for (const [key, value] of Object.entries({
    action: "cargoquery", format: "json", maxlag: "5", tables: "LocationEntity",
    fields: "locationName,entityName,entityType,variantType,level,coords,note",
    order_by: "entityName,locationName", limit: "500", offset: String(offset),
  })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`wiki Cargo request failed with HTTP ${response.status}`);
  const payload = await response.json() as { cargoquery?: Array<{ title?: Record<string, string> }> };
  const page = (payload.cargoquery ?? []).flatMap((entry) => parseRow(entry.title));
  rows.push(...page);
  console.log(`[locations] fetched ${rows.length} rows`);
  if (page.length < 500) break;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
}

if (rows.length === 0) throw new Error("wiki Cargo returned no location rows; previous cache was preserved");
const cache: PalLocationCache = {
  schemaVersion: LOCATION_CACHE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  source: { label: "The Palworld Wiki — LocationEntity Cargo table", url: SOURCE, license: "CC BY-SA 4.0", query: "LocationEntity(locationName,entityName,entityType,variantType,level,coords,note)" },
  rows,
};
await mkdir(dirname(OUTPUT), { recursive: true });
const temp = `${OUTPUT}.tmp`;
await writeFile(temp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
await chmod(temp, 0o600);
await rename(temp, OUTPUT);
console.log(`[locations] wrote ${rows.length} attributed rows to ${OUTPUT}`);

function parseRow(raw?: Record<string, string>): PalLocationRow[] {
  if (!raw) return [];
  const entityName = raw.entityName?.trim() ?? "";
  const locationName = raw.locationName?.trim() ?? "";
  if (!entityName || !locationName) return [];
  const match = raw.coords?.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/u);
  const level = Number(raw.level);
  return [{
    entityName, locationName,
    entityType: raw.entityType?.trim() ?? "",
    variantType: raw.variantType?.trim() ?? "",
    level: raw.level && Number.isFinite(level) ? level : null,
    coords: match ? { x: Number(match[1]), y: Number(match[2]) } : null,
    note: cleanWikitext(raw.note ?? "").slice(0, 500),
  }];
}
