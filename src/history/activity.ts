import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorldSnapshot } from "../snapshots/service.js";
import type { PanelEvent } from "../types.js";

interface ActivityState {
  version: 1;
  onlineSince: Record<string, number>;
}

export interface ActivityChange {
  kind: "join" | "leave";
  uid: string;
  name: string;
  /** Known tracked duration; null only for an untracked leave. */
  durationSec: number | null;
}

/** Restart-safe current-session tracking for the Discord activity feed. */
export class ActivityTracker {
  private state: ActivityState = { version: 1, onlineSince: {} };
  private initialized = false;
  private baselineReady = false;
  private previousOnline = new Set<string>();
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly statePath: string) {}

  async observe(
    snapshot: WorldSnapshot,
    now = Date.now(),
    baselineHints: ReadonlyMap<string, number> = new Map(),
  ): Promise<ActivityChange[]> {
    let changes: ActivityChange[] = [];
    await this.withLock(async () => {
      await this.init();
      if (snapshot.server?.state === "unreachable") {
        this.baselineReady = false;
        return;
      }
      const online = new Set(snapshot.players.filter((player) => player.online).map((player) => player.uid));
      const names = new Map(snapshot.players.map((player) => [player.uid, player.name]));

      if (!this.baselineReady) {
        let dirty = false;
        // Preserve starts loaded from disk only for players still online. Anyone
        // whose leave happened while the bot was down is silently reconciled.
        for (const uid of Object.keys(this.state.onlineSince)) {
          if (!online.has(uid)) {
            delete this.state.onlineSince[uid];
            dirty = true;
          }
        }
        for (const uid of online) {
          const hinted = baselineHints.get(uid);
          const validHint = hinted !== undefined && hinted >= 0 && hinted <= now ? hinted : null;
          if (this.state.onlineSince[uid] === undefined) {
            this.state.onlineSince[uid] = validHint ?? now;
            dirty = true;
          } else if (validHint !== null && validHint < this.state.onlineSince[uid]!) {
            // Repair a prior event-based approximation with the authoritative
            // open-session row when it becomes available.
            this.state.onlineSince[uid] = validHint;
            dirty = true;
          }
        }
        this.previousOnline = online;
        this.baselineReady = true;
        if (dirty) await this.persist();
        return;
      }

      for (const uid of online) {
        if (this.previousOnline.has(uid)) continue;
        this.state.onlineSince[uid] = now;
        changes.push({ kind: "join", uid, name: names.get(uid) ?? "Someone", durationSec: null });
      }
      for (const uid of this.previousOnline) {
        if (online.has(uid)) continue;
        const since = this.state.onlineSince[uid];
        delete this.state.onlineSince[uid];
        changes.push({
          kind: "leave",
          uid,
          name: names.get(uid) ?? "Someone",
          durationSec: since === undefined ? null : Math.max(0, Math.round((now - since) / 1_000)),
        });
      }
      this.previousOnline = online;
      if (changes.length > 0) await this.persist();
    });
    return changes;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<ActivityState>;
      if (parsed.version !== 1 || !parsed.onlineSince || typeof parsed.onlineSince !== "object") {
        throw new Error("unsupported activity state");
      }
      this.state = { version: 1, onlineSince: {} };
      for (const [uid, at] of Object.entries(parsed.onlineSince)) {
        if (uid && typeof at === "number" && Number.isFinite(at) && at >= 0) this.state.onlineSince[uid] = at;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[activity] state ignored:", error);
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  private async withLock(operation: () => Promise<void>): Promise<void> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await operation(); } finally { release(); }
  }
}

/** Recover current-session starts from bounded recent admin events at startup. */
export function activitySeedsFromEvents(events: readonly PanelEvent[]): Map<string, number> {
  const seeds = new Map<string, number>();
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of ordered) {
    if (event.kind !== "join" && event.kind !== "leave") continue;
    const uid = typeof event.meta?.uid === "string" ? event.meta.uid.trim().toLowerCase() : "";
    const at = Date.parse(event.at);
    if (!uid || !Number.isFinite(at)) continue;
    if (event.kind === "join") seeds.set(uid, at);
    else seeds.delete(uid);
  }
  return seeds;
}
