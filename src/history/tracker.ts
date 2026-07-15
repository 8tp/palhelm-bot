import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PanelEvent, RosterPal } from "../types.js";
import type { WorldSnapshot } from "../snapshots/service.js";
import { baseCharacterId } from "../pals/presentation.js";

export type MilestoneKind =
  | "first_species"
  | "first_alpha"
  | "first_lucky"
  | "level"
  | "playtime"
  | "record";

export interface Milestone {
  kind: MilestoneKind;
  playerUid?: string;
  playerName?: string;
  characterId?: string;
  speciesName?: string;
  value?: number;
  recordLabel?: string;
  recordDetail?: string;
  previousPlayerName?: string;
  confidence?: "observed";
  trackingStartedAt?: string;
  observedAt?: string;
}

type RecordKey = "player_level" | "player_playtime" | "pal_level";
interface TrackedRecord {
  holderId: string;
  holderName: string;
  value: number;
  detail: string;
  characterId?: string;
}

interface PlayerObservation {
  name: string;
  level: number;
  playtimeSec: number;
  hasAlpha: boolean;
  hasLucky: boolean;
}

interface PendingMilestoneBatch {
  id: string;
  milestones: Milestone[];
}

interface PendingDigest {
  key: string;
  digest: WeeklyDigest;
}

interface DigestAccumulator {
  startedAt: string;
  activePlayerUids: string[];
  playtimeDeltaSec: number;
  newPalInstances: number;
  newSpecies: string[];
  newAlphas: number;
  newLuckies: number;
  milestoneLines: string[];
  metricSamples: number;
  fpsSum: number;
  fpsLow: number | null;
  firstDay: number | null;
  lastDay: number | null;
  backups: number;
  snapshots: number;
}

/** One compact, periodically sampled point per player for windowed trend math. */
interface HistorySample {
  at: string;
  players: Record<string, { lvl: number; pt: number; pals: number }>;
  /** Optional so version-two files written before health sampling remain valid. */
  fps?: number;
  saveAgeSec?: number;
  backupAgeSec?: number;
  uptimeSec?: number;
}

interface TrackerState {
  version: 4;
  trackingStartedAt: string;
  lastCapturedAt: string | null;
  players: Record<string, PlayerObservation>;
  observedSpecies: Record<string, string>;
  observedInstances: Record<string, true>;
  digest: DigestAccumulator;
  lastDigestKey: string | null;
  pendingMilestones: PendingMilestoneBatch[];
  pendingDigest: PendingDigest | null;
  lastBackupAt: string | null;
  /** Bounded, pruned time series powering /trends and weekly deltas. */
  history: HistorySample[];
  /** Null upgrades older files by establishing one silent record baseline. */
  recordHolders: Record<RecordKey, TrackedRecord | null> | null;
  /** Bounded observed holder-change log used by /records. */
  recordHistory: Milestone[];
}

export interface PlayerTrend {
  uid: string;
  name: string;
  currentLevel: number;
  levelGain: number;
  playtimeGainSec: number;
  palGain: number;
}

export interface TrendReport {
  /** Timestamp of the baseline sample the deltas are measured from. */
  windowStart: string;
  /** False when history does not yet span the full requested window. */
  fullWindow: boolean;
  players: PlayerTrend[];
}

export interface HealthHistorySummary {
  startedAt: string;
  endedAt: string;
  sampleCount: number;
  telemetrySampleCount: number;
  averageFps: number | null;
  lowFps: number | null;
  latestSaveAgeSec: number | null;
  latestBackupAgeSec: number | null;
  latestUptimeSec: number | null;
}

export interface WeeklyDigest {
  startedAt: string;
  endedAt: string;
  activePlayers: string[];
  playtimeDeltaSec: number;
  newPalInstances: number;
  newSpecies: string[];
  newAlphas: number;
  newLuckies: number;
  milestones: string[];
  averageFps: number | null;
  lowFps: number | null;
  firstDay: number | null;
  lastDay: number | null;
  backups: number;
  snapshots: number;
}

export interface ObservationTrackerOptions {
  now?: () => Date;
  /**
   * Trust drifted save data only after two consecutive continuity checks.
   * Confirmation candidates intentionally live only in memory, so a restart
   * requires two fresh consistent drifted snapshots before tracking resumes.
   */
  allowFormatDrift?: boolean;
  /** Minimum spacing between persisted history samples (default 3h). */
  historySampleIntervalMs?: number;
  /** How long history samples are retained before pruning (default 35 days). */
  historyRetentionMs?: number;
  /** Exact CharacterID resolver. When supplied, only canonical Pals can create Pal milestones. */
  resolveCanonicalPal?: (characterId: string) => { internalId: string; name: string } | null;
}

interface SnapshotShape {
  players: Set<string>;
  pals: Set<string>;
  guilds: Set<string>;
}

const LEVEL_MILESTONES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const PLAYTIME_BADGES_SEC = [24, 100, 250, 500, 1_000].map((h) => h * 3_600);
const DEFAULT_HISTORY_SAMPLE_INTERVAL_MS = 3 * 3_600_000;
const DEFAULT_HISTORY_RETENTION_MS = 35 * 86_400_000;

export class ObservationTracker {
  private state: TrackerState | null = null;
  private saveInFlight: Promise<void> = Promise.resolve();
  private operationLock: Promise<void> = Promise.resolve();
  private driftCandidate: SnapshotShape | null = null;
  private driftCandidateAt: string | null = null;
  private lastTrustedShape: SnapshotShape | null = null;
  private readonly now: () => Date;
  private readonly allowFormatDrift: boolean;
  private readonly historySampleIntervalMs: number;
  private readonly historyRetentionMs: number;
  private readonly resolveCanonicalPal?: ObservationTrackerOptions["resolveCanonicalPal"];

  constructor(
    private readonly statePath: string,
    nowOrOptions: (() => Date) | ObservationTrackerOptions = {},
  ) {
    const options = typeof nowOrOptions === "function"
      ? { now: nowOrOptions }
      : nowOrOptions;
    this.now = options.now ?? (() => new Date());
    this.allowFormatDrift = options.allowFormatDrift ?? false;
    this.historySampleIntervalMs = options.historySampleIntervalMs ?? DEFAULT_HISTORY_SAMPLE_INTERVAL_MS;
    this.historyRetentionMs = options.historyRetentionMs ?? DEFAULT_HISTORY_RETENTION_MS;
    this.resolveCanonicalPal = options.resolveCanonicalPal;
  }

  async init(): Promise<void> {
    await this.withLock(() => this.initUnlocked());
  }

  private async initUnlocked(): Promise<void> {
    if (this.state) return;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Omit<TrackerState, "version"> & {
        version: number;
        history?: HistorySample[];
      };
      if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) {
        throw new Error(`unsupported history version ${String(parsed.version)}`);
      }
      const needsPalClaimReset = parsed.version < 3;
      parsed.pendingMilestones ??= [];
      parsed.pendingDigest ??= null;
      parsed.lastBackupAt ??= null;
      parsed.history ??= []; // v1 state predates the time series; start empty.
      parsed.recordHolders ??= null;
      parsed.recordHistory ??= [];
      this.state = { ...parsed, version: 4, history: parsed.history, recordHistory: parsed.recordHistory };
      if (needsPalClaimReset) {
        // v1/v2 accepted any save character as a Pal and could also persist
        // ownerless claims. Keep player/health history, but discard Pal claim
        // lines whose truth cannot be reconstructed from the old string format.
        this.state.digest.newSpecies = [];
        this.state.digest.milestoneLines = this.state.digest.milestoneLines
          .filter((line) => !/ added /.test(line));
        this.state.pendingMilestones = this.state.pendingMilestones
          .map((batch) => ({
            ...batch,
            milestones: batch.milestones.filter((milestone) => !isPalMilestone(milestone)),
          }))
          .filter((batch) => batch.milestones.length > 0);
      }
      this.sanitizeCanonicalPalState();
      // Schema and claim cleanup must be durable even when the next snapshot is
      // intentionally rejected for format drift and observe() cannot persist.
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private sanitizeCanonicalPalState(): void {
    if (!this.state || !this.resolveCanonicalPal) return;
    const canonicalNames = new Set<string>();
    this.state.observedSpecies = Object.fromEntries(
      Object.keys(this.state.observedSpecies).flatMap((characterId) => {
        const known = this.resolveCanonicalPal?.(characterId);
        if (!known) return [];
        canonicalNames.add(known.name);
        return [[known.internalId.toLocaleLowerCase("en-US"), known.name]];
      }),
    );
    this.state.digest.newSpecies = this.state.digest.newSpecies.filter((name) => canonicalNames.has(name));
    this.state.digest.milestoneLines = this.state.digest.milestoneLines.filter((line) => {
      const added = line.match(/^(.*?) added (.+)$/);
      return !added || canonicalNames.has(added[1]!);
    });
    this.state.pendingMilestones = this.state.pendingMilestones
      .map((batch) => ({
        ...batch,
        milestones: batch.milestones.filter((milestone) =>
          !isPalMilestone(milestone) ||
          Boolean(milestone.characterId && this.resolveCanonicalPal?.(milestone.characterId)),
        ),
      }))
      .filter((batch) => batch.milestones.length > 0);
  }

  /** Process one newly captured snapshot. Repeated capturedAt values are ignored. */
  async observe(snapshot: WorldSnapshot): Promise<Milestone[]> {
    return this.withLock(async () => {
    await this.initUnlocked();
    if (this.state?.lastCapturedAt === snapshot.capturedAt) return [];

    if (snapshot.formatDrift && !this.allowFormatDrift) return [];
    if (snapshot.formatDrift && !this.acceptDriftShape(snapshot)) return [];
    if (!this.state) {
      const trackedPals = snapshot.pals.filter((pal) => this.isCanonicalPal(pal));
      this.state = baselineState(snapshot, trackedPals, this.now());
      try {
        await this.persist();
      } catch (error) {
        this.state = null;
        throw error;
      }
      this.lastTrustedShape = shapeOf(snapshot);
      this.driftCandidate = null;
      this.driftCandidateAt = null;
      console.log("[history] baseline ready");
      return [];
    }

    const before = structuredClone(this.state);
    const milestones: Milestone[] = [];
    const playerNames = new Map(snapshot.players.map((player) => [player.uid, player.name]));
    const trackedPals = snapshot.pals.filter((pal) => this.isCanonicalPal(pal));
    const palsByOwner = groupPals(trackedPals);
    const newlyObservedInstances = new Set(
      trackedPals
        .filter((pal) => palOwnerName(pal, playerNames) !== null)
        .filter((pal) => !this.state!.observedInstances[pal.instanceId])
        .map((pal) => pal.instanceId),
    );
    const digest = this.state.digest;
    const active = new Set(digest.activePlayerUids);

    for (const player of snapshot.players) {
      const previous = this.state.players[player.uid];
      const owned = palsByOwner.get(player.uid) ?? [];
      const hasAlpha = owned.some((pal) => pal.isAlpha);
      const hasLucky = owned.some((pal) => pal.isLucky);
      if (previous) {
        const playtimeDelta = Math.max(0, player.playtimeSec - previous.playtimeSec);
        if (playtimeDelta > 0) {
          active.add(player.uid);
          digest.playtimeDeltaSec += playtimeDelta;
        }
        for (const level of LEVEL_MILESTONES) {
          if (previous.level < level && player.level >= level) {
            milestones.push({ kind: "level", playerUid: player.uid, playerName: player.name, value: level });
          }
        }
        for (const seconds of PLAYTIME_BADGES_SEC) {
          if (previous.playtimeSec < seconds && player.playtimeSec >= seconds) {
            milestones.push({ kind: "playtime", playerUid: player.uid, playerName: player.name, value: seconds });
          }
        }
        const firstAlpha = owned.find((pal) => pal.isAlpha && newlyObservedInstances.has(pal.instanceId));
        if (!previous.hasAlpha && firstAlpha) {
          milestones.push({
            kind: "first_alpha",
            playerUid: player.uid,
            playerName: player.name,
            characterId: firstAlpha.characterId,
            speciesName: firstAlpha.displayName,
          });
        }
        const firstLucky = owned.find((pal) => pal.isLucky && newlyObservedInstances.has(pal.instanceId));
        if (!previous.hasLucky && firstLucky) {
          milestones.push({
            kind: "first_lucky",
            playerUid: player.uid,
            playerName: player.name,
            characterId: firstLucky.characterId,
            speciesName: firstLucky.displayName,
          });
        }
      }
      this.state.players[player.uid] = {
        name: player.name,
        level: Math.max(previous?.level ?? 0, player.level),
        playtimeSec: Math.max(previous?.playtimeSec ?? 0, player.playtimeSec),
        hasAlpha: previous?.hasAlpha === true || hasAlpha,
        hasLucky: previous?.hasLucky === true || hasLucky,
      };
    }
    digest.activePlayerUids = [...active];

    for (const pal of trackedPals) {
      const ownerName = palOwnerName(pal, playerNames);
      // Ownership can briefly be absent while save-derived provenance catches
      // up. Do not consume first-observed state until the Pal can be tied to a
      // real player; a later complete snapshot may then announce it correctly.
      if (!ownerName) continue;
      if (!this.state.observedInstances[pal.instanceId]) {
        this.state.observedInstances[pal.instanceId] = true;
        digest.newPalInstances++;
        if (pal.isAlpha) digest.newAlphas++;
        if (pal.isLucky) digest.newLuckies++;
      }
      const speciesKey = baseCharacterId(pal.characterId).toLowerCase();
      if (!this.state.observedSpecies[speciesKey]) {
        this.state.observedSpecies[speciesKey] = pal.displayName;
        digest.newSpecies.push(pal.displayName);
        milestones.push({
          kind: "first_species",
          playerUid: pal.ownerUid,
          playerName: ownerName,
          characterId: pal.characterId,
          speciesName: pal.displayName,
        });
      }
    }

    milestones.push(...this.observeRecords(snapshot, trackedPals));

    const deliverableMilestones = milestones.filter(isDeliverableMilestone);
    for (const milestone of deliverableMilestones) {
      const line = milestoneLine(milestone);
      if (line) digest.milestoneLines.push(line);
    }
    if (deliverableMilestones.length > 0) {
      this.state.pendingMilestones.push({ id: snapshot.capturedAt, milestones: deliverableMilestones });
    }
    this.sampleMetrics(snapshot);
    this.sampleHistory(snapshot);
    digest.snapshots++;
    this.state.lastCapturedAt = snapshot.capturedAt;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    this.lastTrustedShape = shapeOf(snapshot);
    this.driftCandidate = null;
    this.driftCandidateAt = null;
    return deliverableMilestones;
    });
  }

  private isCanonicalPal(pal: RosterPal): boolean {
    if (this.resolveCanonicalPal) return this.resolveCanonicalPal(pal.characterId) !== null;
    return pal.canonical === true;
  }

  async recordPanelEvent(event: PanelEvent): Promise<void> {
    if (event.kind !== "backup") return;
    await this.withLock(async () => {
    await this.initUnlocked();
    if (!this.state) return; // Wait for the first world snapshot baseline.
    const before = structuredClone(this.state);
    this.state.digest.backups++;
    this.state.lastBackupAt = event.at;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    });
  }

  lastBackupAt(): string | null {
    return this.state?.lastBackupAt ?? null;
  }

  nextMilestoneBatch(): PendingMilestoneBatch | null {
    return this.state?.pendingMilestones[0] ?? null;
  }

  /** Newest-first, bounded, safe observed record-holder changes. */
  recordHistory(limit = 20): Milestone[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return [...(this.state?.recordHistory ?? [])].reverse().slice(0, bounded);
  }

  async ackMilestoneBatch(id: string): Promise<void> {
    await this.withLock(async () => {
    await this.initUnlocked();
    if (!this.state || this.state.pendingMilestones[0]?.id !== id) return;
    const before = structuredClone(this.state);
    this.state.pendingMilestones.shift();
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    });
  }

  /** Prepare a durable pending digest; acknowledge it only after Discord accepts it. */
  nextPendingDigest(): PendingDigest | null {
    return this.state?.pendingDigest ?? null;
  }

  async prepareDigest(key: string, snapshot: WorldSnapshot | null): Promise<PendingDigest | null> {
    return this.withLock(async () => {
    await this.initUnlocked();
    if (!this.state) return null;
    if (this.state.pendingDigest) return this.state.pendingDigest;
    if (this.state.lastDigestKey === key) return null;
    const before = structuredClone(this.state);
    const old = this.state.digest;
    const playerNames = new Map(snapshot?.players.map((p) => [p.uid, p.name]) ?? []);
    const digest: WeeklyDigest = {
      startedAt: old.startedAt,
      endedAt: this.now().toISOString(),
      activePlayers: old.activePlayerUids.map((uid) => playerNames.get(uid) ?? this.state!.players[uid]?.name ?? "Unknown"),
      playtimeDeltaSec: old.playtimeDeltaSec,
      newPalInstances: old.newPalInstances,
      newSpecies: [...old.newSpecies],
      newAlphas: old.newAlphas,
      newLuckies: old.newLuckies,
      milestones: [...old.milestoneLines],
      averageFps: old.metricSamples ? old.fpsSum / old.metricSamples : null,
      lowFps: old.fpsLow,
      firstDay: old.firstDay,
      lastDay: old.lastDay,
      backups: old.backups,
      snapshots: old.snapshots,
    };
    const pending = { key, digest };
    this.state.pendingDigest = pending;
    this.state.digest = emptyDigest(this.now().toISOString());
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return pending;
    });
  }

  async ackDigest(key: string): Promise<void> {
    await this.withLock(async () => {
    await this.initUnlocked();
    if (!this.state || this.state.pendingDigest?.key !== key) return;
    const before = structuredClone(this.state);
    this.state.lastDigestKey = key;
    this.state.pendingDigest = null;
    try {
      await this.persist();
    } catch (error) {
      this.state = before;
      throw error;
    }
    });
  }

  private sampleMetrics(snapshot: WorldSnapshot): void {
    const metrics = snapshot.metricsCurrent;
    if (!this.state || !metrics) return;
    const digest = this.state.digest;
    digest.metricSamples++;
    digest.fpsSum += metrics.fps;
    digest.fpsLow = digest.fpsLow === null ? metrics.fps : Math.min(digest.fpsLow, metrics.fps);
    digest.firstDay ??= metrics.day;
    digest.lastDay = metrics.day;
  }

  /** Append a per-player point at most once per sample interval, then prune old ones. */
  private sampleHistory(snapshot: WorldSnapshot): void {
    if (!this.state) return;
    const now = this.now();
    const last = this.state.history.at(-1);
    if (last && now.getTime() - Date.parse(last.at) < this.historySampleIntervalMs) return;
    this.state.history.push(historySample(snapshot, now, this.state.lastBackupAt));
    const cutoff = now.getTime() - this.historyRetentionMs;
    // Keep one point older than the cutoff so a full-window baseline stays available.
    const firstFresh = this.state.history.findIndex((sample) => Date.parse(sample.at) >= cutoff);
    if (firstFresh > 1) this.state.history.splice(0, firstFresh - 1);
  }

  /**
   * Per-player growth over the trailing window, measured from the newest sample
   * at or before the window start (or the oldest sample if history is shorter).
   * Current values come from the live snapshot, so deltas include the latest data.
   */
  trends(windowMs: number, snapshot: WorldSnapshot): TrendReport | null {
    if (!this.state || this.state.history.length === 0) return null;
    const history = this.state.history;
    const targetMs = this.now().getTime() - windowMs;
    let baseline = history[0]!;
    let fullWindow = false;
    for (const sample of history) {
      if (Date.parse(sample.at) <= targetMs) {
        baseline = sample;
        fullWindow = true;
      } else {
        break;
      }
    }
    const palCounts = new Map<string, number>();
    for (const pal of snapshot.pals) palCounts.set(pal.ownerUid, (palCounts.get(pal.ownerUid) ?? 0) + 1);
    const players: PlayerTrend[] = [];
    for (const player of snapshot.players) {
      const start = baseline.players[player.uid];
      if (!start) continue; // Player was not yet tracked at the window start.
      players.push({
        uid: player.uid,
        name: player.name,
        currentLevel: player.level,
        levelGain: Math.max(0, player.level - start.lvl),
        playtimeGainSec: Math.max(0, player.playtimeSec - start.pt),
        palGain: (palCounts.get(player.uid) ?? 0) - start.pals,
      });
    }
    return { windowStart: baseline.at, fullWindow, players };
  }

  /** Safe aggregate over the existing bounded history; never refreshes live data. */
  healthHistorySummary(): HealthHistorySummary | null {
    if (!this.state) return null;
    const samples = this.state.history.filter(hasHealthMeasurement);
    if (samples.length === 0) return null;
    const fps = samples
      .map((sample) => sample.fps)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const latest = samples.at(-1)!;
    return {
      startedAt: samples[0]!.at,
      endedAt: latest.at,
      sampleCount: samples.length,
      telemetrySampleCount: fps.length,
      averageFps: fps.length > 0 ? fps.reduce((sum, value) => sum + value, 0) / fps.length : null,
      lowFps: fps.length > 0 ? Math.min(...fps) : null,
      latestSaveAgeSec: finiteOrNull(latest.saveAgeSec),
      latestBackupAgeSec: finiteOrNull(latest.backupAgeSec),
      latestUptimeSec: finiteOrNull(latest.uptimeSec),
    };
  }

  private observeRecords(snapshot: WorldSnapshot, trackedPals: readonly RosterPal[]): Milestone[] {
    if (!this.state) return [];
    const candidates = recordCandidates(snapshot, trackedPals);
    if (this.state.recordHolders === null) {
      this.state.recordHolders = candidates;
      return [];
    }
    const milestones: Milestone[] = [];
    for (const key of Object.keys(candidates) as RecordKey[]) {
      const candidate = candidates[key];
      const previous = this.state.recordHolders[key];
      if (!candidate) continue;
      if (!previous) {
        this.state.recordHolders[key] = candidate;
        continue;
      }
      if (candidate.holderId === previous.holderId) {
        if (candidate.value > previous.value) this.state.recordHolders[key] = candidate;
        continue;
      }
      if (candidate.value <= previous.value) continue;
      this.state.recordHolders[key] = candidate;
      const milestone: Milestone = {
        kind: "record",
        playerUid: candidate.holderId,
        playerName: candidate.holderName,
        characterId: candidate.characterId,
        previousPlayerName: previous.holderName,
        value: candidate.value,
        recordLabel: recordLabel(key),
        recordDetail: candidate.detail,
        confidence: "observed",
        trackingStartedAt: this.state.trackingStartedAt,
        observedAt: snapshot.capturedAt,
      };
      milestones.push(milestone);
      this.state.recordHistory.push(milestone);
      if (this.state.recordHistory.length > 100) this.state.recordHistory.splice(0, this.state.recordHistory.length - 100);
    }
    return milestones;
  }

  trackingStartedAt(): string | null {
    return this.state?.trackingStartedAt ?? null;
  }

  private persist(): Promise<void> {
    if (!this.state) return Promise.resolve();
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    const tempPath = `${this.statePath}.tmp`;
    this.saveInFlight = this.saveInFlight.catch(() => {}).then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.statePath);
    });
    return this.saveInFlight;
  }

  /**
   * A drifted snapshot is accepted only when it follows the last accepted
   * shape, or when two consecutive snapshots establish the same new shape.
   */
  private acceptDriftShape(snapshot: WorldSnapshot): boolean {
    const shape = shapeOf(snapshot);
    if (!viableShape(shape)) {
      this.driftCandidate = null;
      this.driftCandidateAt = null;
      return false;
    }
    if (this.lastTrustedShape && shapesConsistent(this.lastTrustedShape, shape)) {
      return true;
    }
    if (
      this.driftCandidate &&
      this.driftCandidateAt !== snapshot.capturedAt &&
      shapesConsistent(this.driftCandidate, shape)
    ) {
      return true;
    }
    this.driftCandidate = shape;
    this.driftCandidateAt = snapshot.capturedAt;
    return false;
  }

  /** Serialize the full read/mutate/persist/rollback transaction, not just writes. */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationLock;
    let release!: () => void;
    this.operationLock = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function shapeOf(snapshot: WorldSnapshot): SnapshotShape {
  return {
    players: new Set(snapshot.players.map((player) => player.uid)),
    pals: new Set(snapshot.pals.map((pal) => pal.instanceId)),
    guilds: new Set(snapshot.guilds.map((guild) => guild.id)),
  };
}

function viableShape(shape: SnapshotShape): boolean {
  // Trusted drift mode is recovery-oriented. Empty worlds are too ambiguous
  // to distinguish from a collapsed parser result and remain rejected.
  return shape.players.size > 0 && shape.pals.size > 0;
}

function shapesConsistent(previous: SnapshotShape, next: SnapshotShape): boolean {
  return countConsistent(previous.players.size, next.players.size)
    && countConsistent(previous.pals.size, next.pals.size)
    && countConsistent(previous.guilds.size, next.guilds.size)
    && overlapAtLeast(previous.players, next.players, 0.8)
    && overlapAtLeast(previous.pals, next.pals, 0.7)
    && overlapAtLeast(previous.guilds, next.guilds, 0.5);
}

function countConsistent(previous: number, next: number): boolean {
  const difference = Math.abs(previous - next);
  if (difference <= 2) return true;
  return Math.min(previous, next) / Math.max(previous, next) >= 0.8;
}

function overlapAtLeast(previous: Set<string>, next: Set<string>, ratio: number): boolean {
  const smaller = Math.min(previous.size, next.size);
  if (smaller === 0) return previous.size === next.size;
  let overlap = 0;
  for (const value of previous) {
    if (next.has(value)) overlap++;
  }
  return overlap / smaller >= ratio;
}

function baselineState(snapshot: WorldSnapshot, trackedPals: readonly RosterPal[], now: Date): TrackerState {
  const palsByOwner = groupPals(trackedPals);
  const playerNames = new Map(snapshot.players.map((player) => [player.uid, player.name]));
  const attributablePals = trackedPals.filter((pal) => palOwnerName(pal, playerNames) !== null);
  const players: Record<string, PlayerObservation> = {};
  for (const player of snapshot.players) {
    const pals = palsByOwner.get(player.uid) ?? [];
    players[player.uid] = {
      name: player.name,
      level: player.level,
      playtimeSec: player.playtimeSec,
      hasAlpha: pals.some((pal) => pal.isAlpha),
      hasLucky: pals.some((pal) => pal.isLucky),
    };
  }
  return {
    version: 4,
    trackingStartedAt: now.toISOString(),
    lastCapturedAt: snapshot.capturedAt,
    players,
    observedSpecies: Object.fromEntries(attributablePals.map((pal) => [baseCharacterId(pal.characterId).toLowerCase(), pal.displayName])),
    observedInstances: Object.fromEntries(attributablePals.map((pal) => [pal.instanceId, true])),
    digest: emptyDigest(now.toISOString()),
    lastDigestKey: null,
    pendingMilestones: [],
    pendingDigest: null,
    lastBackupAt: null,
    history: [historySample(snapshot, now, null)],
    recordHolders: recordCandidates(snapshot, trackedPals),
    recordHistory: [],
  };
}

function historySample(snapshot: WorldSnapshot, now: Date, lastBackupAt: string | null): HistorySample {
  const palCounts = new Map<string, number>();
  for (const pal of snapshot.pals) palCounts.set(pal.ownerUid, (palCounts.get(pal.ownerUid) ?? 0) + 1);
  const players: HistorySample["players"] = {};
  for (const player of snapshot.players) {
    players[player.uid] = { lvl: player.level, pt: player.playtimeSec, pals: palCounts.get(player.uid) ?? 0 };
  }
  const nowMs = now.getTime();
  const fps = finiteOrUndefined(snapshot.metricsCurrent?.fps);
  const uptimeSec = finiteOrUndefined(snapshot.metricsCurrent?.uptimeSec ?? snapshot.server?.uptimeSec);
  const saveAgeSec = ageSeconds(nowMs, snapshot.lastParseAt);
  const backupAgeSec = ageSeconds(nowMs, lastBackupAt);
  return {
    at: now.toISOString(),
    players,
    ...(fps === undefined ? {} : { fps }),
    ...(saveAgeSec === undefined ? {} : { saveAgeSec }),
    ...(backupAgeSec === undefined ? {} : { backupAgeSec }),
    ...(uptimeSec === undefined ? {} : { uptimeSec }),
  };
}

function ageSeconds(nowMs: number, at: string | null): number | undefined {
  if (!at) return undefined;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 1_000) : undefined;
}

function finiteOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasHealthMeasurement(sample: HistorySample): boolean {
  return sample.fps !== undefined || sample.saveAgeSec !== undefined ||
    sample.backupAgeSec !== undefined || sample.uptimeSec !== undefined;
}

function emptyDigest(startedAt: string): DigestAccumulator {
  return {
    startedAt,
    activePlayerUids: [],
    playtimeDeltaSec: 0,
    newPalInstances: 0,
    newSpecies: [],
    newAlphas: 0,
    newLuckies: 0,
    milestoneLines: [],
    metricSamples: 0,
    fpsSum: 0,
    fpsLow: null,
    firstDay: null,
    lastDay: null,
    backups: 0,
    snapshots: 0,
  };
}

function groupPals(pals: readonly RosterPal[]): Map<string, RosterPal[]> {
  const grouped = new Map<string, RosterPal[]>();
  for (const pal of pals) {
    const list = grouped.get(pal.ownerUid) ?? [];
    list.push(pal);
    grouped.set(pal.ownerUid, list);
  }
  return grouped;
}

function palOwnerName(pal: RosterPal, playerNames: ReadonlyMap<string, string>): string | null {
  const uid = pal.ownerUid.trim();
  if (!uid) return null;
  const linkedName = playerNames.get(uid)?.trim();
  if (linkedName) return linkedName;
  const embeddedName = pal.ownerName.trim();
  if (!embeddedName || /^(?:owner\s+)?unavailable$/i.test(embeddedName)) return null;
  return embeddedName;
}

/** Guards both newly generated and persisted pre-fix milestone batches. */
export function isDeliverableMilestone(milestone: Milestone): boolean {
  if (!milestone.playerName?.trim()) return false;
  switch (milestone.kind) {
    case "first_species": return Boolean(milestone.speciesName?.trim());
    case "level":
    case "playtime": return Number.isFinite(milestone.value);
    case "record": return Boolean(
      milestone.previousPlayerName?.trim() &&
      milestone.recordLabel?.trim() &&
      milestone.recordDetail?.trim(),
    );
    case "first_alpha":
    case "first_lucky": return true;
  }
}

function isPalMilestone(milestone: Milestone): boolean {
  return milestone.kind === "first_species" ||
    milestone.kind === "first_alpha" ||
    milestone.kind === "first_lucky" ||
    milestone.kind === "record" && milestone.characterId !== undefined;
}

function milestoneLine(milestone: Milestone): string | null {
  switch (milestone.kind) {
    case "first_species": return `${milestone.playerName} added ${milestone.speciesName}`;
    case "first_alpha": return `${milestone.playerName} found their first Alpha`;
    case "first_lucky": return `${milestone.playerName} found their first Lucky`;
    case "level": return `${milestone.playerName} reached Lv ${milestone.value}`;
    case "playtime": return `${milestone.playerName} passed ${Math.round((milestone.value ?? 0) / 3_600)}h`;
    case "record": return `${milestone.playerName} passed ${milestone.previousPlayerName} for ${milestone.recordLabel} (${milestone.recordDetail}) · observed record`;
  }
}

function recordCandidates(
  snapshot: WorldSnapshot,
  trackedPals: readonly RosterPal[],
): Record<RecordKey, TrackedRecord | null> {
  const playerNames = new Map(snapshot.players.map((player) => [player.uid, player.name]));
  const topLevel = [...snapshot.players].sort((a, b) => b.level - a.level || a.uid.localeCompare(b.uid))[0];
  const topPlaytime = [...snapshot.players].sort((a, b) => b.playtimeSec - a.playtimeSec || a.uid.localeCompare(b.uid))[0];
  const topPal = [...trackedPals]
    .filter((pal) => palOwnerName(pal, playerNames) !== null)
    .sort((a, b) => b.level - a.level || a.instanceId.localeCompare(b.instanceId))[0];
  return {
    player_level: topLevel ? {
      holderId: topLevel.uid, holderName: topLevel.name, value: topLevel.level, detail: `Lv ${topLevel.level}`,
    } : null,
    player_playtime: topPlaytime ? {
      holderId: topPlaytime.uid, holderName: topPlaytime.name, value: topPlaytime.playtimeSec,
      detail: `${Math.floor(topPlaytime.playtimeSec / 3_600)}h played`,
    } : null,
    pal_level: topPal ? {
      holderId: topPal.ownerUid, holderName: palOwnerName(topPal, playerNames)!, value: topPal.level,
      detail: `Lv ${topPal.level} ${topPal.displayName}`, characterId: topPal.characterId,
    } : null,
  };
}

function recordLabel(key: RecordKey): string {
  switch (key) {
    case "player_level": return "highest player level";
    case "player_playtime": return "longest playtime";
    case "pal_level": return "highest-level Pal";
  }
}
