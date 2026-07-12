import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorldSnapshot } from "../snapshots/service.js";

export type HealthNoticeKind = "low_fps" | "fps_recovered" | "save_stale" | "save_recovered" | "backup_overdue" | "backup_recovered";
export interface HealthNotice {
  kind: HealthNoticeKind;
  message: string;
}

export interface HealthWatchOptions {
  lowFps?: number;
  recoveredFps?: number;
  consecutiveSamples?: number;
  staleAfterMs?: number;
  backupOverdueMs?: number;
  now?: () => number;
  /** Optional restart-safe state file. Omit for an in-memory observer. */
  statePath?: string;
}

interface HealthWatchState {
  version: 1;
  lastCapturedAt: string;
  lowSamples: number;
  healthySamples: number;
  lowFpsActive: boolean;
  staleActive: boolean;
  backupOverdueActive: boolean;
}

const EMPTY_STATE: HealthWatchState = {
  version: 1,
  lastCapturedAt: "",
  lowSamples: 0,
  healthySamples: 0,
  lowFpsActive: false,
  staleActive: false,
  backupOverdueActive: false,
};

/** Hysteresis-only observer. It reports state changes and never remediates them. */
export class HealthWatch {
  private state: HealthWatchState = structuredClone(EMPTY_STATE);
  private initialized = false;
  private lock: Promise<void> = Promise.resolve();
  private readonly lowFps: number;
  private readonly recoveredFps: number;
  private readonly consecutiveSamples: number;
  private readonly staleAfterMs: number;
  private readonly backupOverdueMs: number;
  private readonly now: () => number;
  private readonly statePath?: string;

  constructor(options: HealthWatchOptions = {}) {
    this.lowFps = options.lowFps ?? 40;
    this.recoveredFps = options.recoveredFps ?? 50;
    this.consecutiveSamples = options.consecutiveSamples ?? 2;
    this.staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
    this.backupOverdueMs = options.backupOverdueMs ?? 26 * 60 * 60_000;
    this.now = options.now ?? Date.now;
    this.statePath = options.statePath;
  }

  async init(): Promise<void> {
    await this.withLock(() => this.initUnlocked());
  }

  async observe(snapshot: WorldSnapshot, lastBackupAt: string | null = null): Promise<HealthNotice[]> {
    let result: HealthNotice[] = [];
    await this.withLock(async () => {
      await this.initUnlocked();
      const before = JSON.stringify(this.state);
      result = this.observeUnlocked(snapshot, lastBackupAt);
      if (JSON.stringify(this.state) !== before) await this.persist();
    });
    return result;
  }

  private observeUnlocked(snapshot: WorldSnapshot, lastBackupAt: string | null): HealthNotice[] {
    const fresh = snapshot.capturedAt !== this.state.lastCapturedAt;
    if (fresh) this.state.lastCapturedAt = snapshot.capturedAt;
    const notices: HealthNotice[] = [];
    const fps = snapshot.metricsCurrent?.fps;
    if (fresh && typeof fps === "number" && Number.isFinite(fps)) {
      if (fps < this.lowFps) {
        this.state.lowSamples++;
        this.state.healthySamples = 0;
      } else if (fps >= this.recoveredFps) {
        this.state.healthySamples++;
        this.state.lowSamples = 0;
      } else {
        this.state.lowSamples = 0;
        this.state.healthySamples = 0;
      }
      if (!this.state.lowFpsActive && this.state.lowSamples >= this.consecutiveSamples) {
        this.state.lowFpsActive = true;
        notices.push({ kind: "low_fps", message: `Server FPS has remained below ${this.lowFps} for ${this.state.lowSamples} fresh samples (latest: ${fps.toFixed(1)}).` });
      } else if (this.state.lowFpsActive && this.state.healthySamples >= this.consecutiveSamples) {
        this.state.lowFpsActive = false;
        notices.push({ kind: "fps_recovered", message: `Server FPS recovered to ${fps.toFixed(1)} after sustained degradation.` });
      }
    }

    const parsed = snapshot.lastParseAt ? Date.parse(snapshot.lastParseAt) : Number.NaN;
    const stale = !Number.isFinite(parsed) || this.now() - parsed >= this.staleAfterMs;
    if (stale && !this.state.staleActive) {
      this.state.staleActive = true;
      notices.push({ kind: "save_stale", message: "The public save snapshot is stale; historical and ownership claims may be delayed." });
    } else if (!stale && this.state.staleActive) {
      this.state.staleActive = false;
      notices.push({ kind: "save_recovered", message: "Fresh save parsing has recovered." });
    }
    if (lastBackupAt) {
      const backupAge = this.now() - Date.parse(lastBackupAt);
      const overdue = Number.isFinite(backupAge) && backupAge >= this.backupOverdueMs;
      if (overdue && !this.state.backupOverdueActive) {
        this.state.backupOverdueActive = true;
        notices.push({ kind: "backup_overdue", message: "No completed backup has been observed within the configured 26-hour health window." });
      } else if (!overdue && this.state.backupOverdueActive) {
        this.state.backupOverdueActive = false;
        notices.push({ kind: "backup_recovered", message: "Backup completion reporting has recovered." });
      }
    }
    return notices;
  }

  private async initUnlocked(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.statePath) return;
    try {
      this.state = validateState(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A malformed optional alert-state file must not prevent the bot from
      // observing health. Log it and start again from a safe baseline.
      console.error("[health] state ignored:", error);
      this.state = structuredClone(EMPTY_STATE);
    }
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.statePath);
  }

  private async withLock(operation: () => Promise<void>): Promise<void> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }
}

function validateState(value: unknown): HealthWatchState {
  if (!value || typeof value !== "object") throw new Error("invalid health state");
  const state = value as Partial<HealthWatchState> & { version?: unknown };
  if (state.version !== 1) throw new Error(`unsupported health state version ${String(state.version)}`);
  return {
    version: 1,
    lastCapturedAt: typeof state.lastCapturedAt === "string" ? state.lastCapturedAt : "",
    lowSamples: nonnegativeInteger(state.lowSamples),
    healthySamples: nonnegativeInteger(state.healthySamples),
    lowFpsActive: state.lowFpsActive === true,
    staleActive: state.staleActive === true,
    backupOverdueActive: state.backupOverdueActive === true,
  };
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
