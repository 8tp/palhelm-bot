import type { WorldSnapshot } from "./service.js";

const STALE_AFTER_MS = 10 * 60_000;

/** Public warning shared by commands that render a last-good world snapshot. */
export function snapshotWarning(
  snapshot: WorldSnapshot,
  suppressDrift: boolean,
  now = Date.now(),
): string | null {
  const warnings: string[] = [];
  if (snapshot.formatDrift && !suppressDrift) {
    warnings.push("⚠️ Save format drift detected — data may be incomplete or missing.");
  }
  const ageMs = now - Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(ageMs) || ageMs >= STALE_AFTER_MS) {
    warnings.push("⚠️ Live refresh is unavailable — showing the last successful snapshot.");
  }
  return warnings.length > 0 ? warnings.join("\n") : null;
}
