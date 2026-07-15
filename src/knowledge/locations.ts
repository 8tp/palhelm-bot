import { readFile } from "node:fs/promises";

export const LOCATION_CACHE_SCHEMA_VERSION = 1;
export interface PalLocationRow {
  locationName: string;
  entityName: string;
  entityType: string;
  variantType: string;
  level: number | null;
  coords: { x: number; y: number } | null;
  note: string;
}
export interface PalLocationCache {
  schemaVersion: typeof LOCATION_CACHE_SCHEMA_VERSION;
  generatedAt: string;
  source: { label: string; url: string; license: string; query: string };
  rows: PalLocationRow[];
}

/** Restart-safe local view of the attributed wiki Cargo encounter table. */
export class PalLocationService {
  private cache: PalLocationCache | null = null;
  constructor(private readonly cachePath: string) {}

  async init(): Promise<void> {
    try {
      this.cache = validateLocationCache(JSON.parse(await readFile(this.cachePath, "utf8")));
    } catch {
      this.cache = null;
    }
  }

  search(entity: string, limit = 20): PalLocationRow[] {
    const key = normalize(entity);
    if (!key || !this.cache) return [];
    return this.cache.rows.filter((row) => normalize(row.entityName) === key)
      .sort((a, b) => Number(b.coords !== null) - Number(a.coords !== null) || Number(Boolean(b.variantType)) - Number(Boolean(a.variantType)) || a.locationName.localeCompare(b.locationName))
      .slice(0, Math.max(1, Math.min(50, Math.trunc(limit))));
  }

  status(): { available: boolean; rowCount: number; generatedAt: string | null; sourceUrl: string | null; license: string | null } {
    return {
      available: this.cache !== null,
      rowCount: this.cache?.rows.length ?? 0,
      generatedAt: this.cache?.generatedAt ?? null,
      sourceUrl: this.cache?.source.url ?? null,
      license: this.cache?.source.license ?? null,
    };
  }
}

export function validateLocationCache(value: unknown): PalLocationCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid location cache");
  const root = value as Partial<PalLocationCache>;
  if (root.schemaVersion !== LOCATION_CACHE_SCHEMA_VERSION || !Array.isArray(root.rows) || root.rows.length > 100_000 || !root.source || typeof root.generatedAt !== "string") throw new Error("invalid location cache");
  const rows = root.rows.filter(validRow).map((row) => structuredClone(row));
  if (rows.length !== root.rows.length) throw new Error("invalid location row");
  return { ...root, rows } as PalLocationCache;
}

function validRow(value: unknown): value is PalLocationRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<PalLocationRow>;
  return [row.locationName, row.entityName, row.entityType, row.variantType, row.note].every((item) => typeof item === "string" && item.length <= 500) &&
    (row.level === null || typeof row.level === "number" && Number.isFinite(row.level)) &&
    (row.coords === null || Boolean(row.coords && Number.isFinite(row.coords.x) && Number.isFinite(row.coords.y)));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}
