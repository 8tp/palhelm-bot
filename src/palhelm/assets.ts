// Session-authed binary asset access with an in-memory cache:
//   - map tiles:  GET {base}/map-tiles/{layer}/{z}/{x}/{y}.{png|webp}
//                 (layer segment omitted for single-layer/legacy pyramids)
//   - pal icons:  GET {base}/api/v1/paldeck/icon/{characterId}
// Both return null on 404 — pyramids/icons are operator-fetched and may be
// absent; callers must degrade to text-only output.
import type { SessionClient, BinaryAsset } from "./session.js";
import { baseCharacterId } from "../pals/presentation.js";

const MAX_ENTRIES = 500;
const NEGATIVE_TTL_MS = 5 * 60_000;

/** Cached payload: a real asset, or null for a remembered 404. */
interface CacheValue {
  asset: BinaryAsset | null;
  cachedAt: number;
}

export class AssetCache {
  /** Insertion-ordered map; oldest key is first under FIFO eviction. */
  private readonly cache = new Map<string, CacheValue>();

  constructor(private readonly session: SessionClient) {}

  async tile(
    layer: string | null,
    z: number,
    x: number,
    y: number,
    format: string,
  ): Promise<BinaryAsset | null> {
    const seg = layer ? `${encodeURIComponent(layer)}/` : "";
    return this.fetch(`/map-tiles/${seg}${z}/${x}/${y}.${format}`);
  }

  async palIcon(characterId: string): Promise<BinaryAsset | null> {
    // Save records prefix Alpha/boss instances with BOSS_, while the icon
    // dataset is keyed by the underlying canonical CharacterID.
    const canonicalId = baseCharacterId(characterId);
    return this.fetch(`/api/v1/paldeck/icon/${encodeURIComponent(canonicalId)}`);
  }

  /** Steam avatar proxied and cached by the panel; null for private/non-Steam identities. */
  async playerAvatar(uid: string): Promise<BinaryAsset | null> {
    return this.fetch(`/api/v1/players/${encodeURIComponent(uid)}/avatar`);
  }

  private async fetch(path: string): Promise<BinaryAsset | null> {
    const cached = this.cache.get(path);
    if (cached && (cached.asset !== null || Date.now() - cached.cachedAt < NEGATIVE_TTL_MS)) {
      return cached.asset;
    }
    if (cached) this.cache.delete(path);
    const asset = await this.session.binary(path);
    this.put(path, asset);
    return asset;
  }

  private put(path: string, value: BinaryAsset | null): void {
    // Refresh key if present so a re-fetch after eviction stays consistent.
    if (this.cache.has(path)) this.cache.delete(path);
    while (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(path, { asset: value, cachedAt: Date.now() });
  }
}
