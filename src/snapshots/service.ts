import type { IntegrationClient } from "../palhelm/integration.js";
import { ApiError, RateLimitedError } from "../palhelm/integration.js";
import type {
  GameDataWorldSummary,
  GameDataWorldWorkers,
  Guild,
  MetricsCurrent,
  PlayerSummary,
  RosterPal,
  ServerInfo,
} from "../types.js";

/** A consistent view of the public integration data used by social features. */
export interface WorldSnapshot {
  players: PlayerSummary[];
  pals: RosterPal[];
  guilds: Guild[];
  metricsCurrent: MetricsCurrent | null;
  server: ServerInfo | null;
  /** Optional aggregate-only Palworld Game Data API snapshot. */
  worldSummary?: GameDataWorldSummary | null;
  /** Optional exact-linked live base workers from the same panel poller cache. */
  liveWorkers?: GameDataWorldWorkers | null;
  /** True when any save-derived response reports parser drift. */
  formatDrift: boolean;
  /** Newest parse timestamp reported by the atomic save-derived responses. */
  lastParseAt: string | null;
  /** Time at which this snapshot refresh completed. */
  capturedAt: string;
}

export interface SnapshotServiceOptions {
  /** How long get() may return the snapshot without revalidating it. */
  maxAgeMs?: number;
  /** Delay between background refresh attempts. */
  pollIntervalMs?: number;
  /** Maximum retry delay after non-rate-limit failures. */
  maxBackoffMs?: number;
  /** Initial retry delay after a transient non-rate-limit failure. */
  failureBackoffMs?: number;
  /** Maximum age of a last-good optional live-world sample. */
  liveDataMaxAgeMs?: number;
  /** Test seam for the clock. */
  now?: () => number;
  /**
   * Optional per-Pal display-name resolver applied to every snapshot, used to
   * replace raw save identifiers (e.g. "PinkRabbit_Grass") with localized names.
   */
  resolvePalName?: (characterId: string, rawDisplayName: string) => string;
  /** Exact canonical catalogue membership used to gate Pal claims/milestones. */
  isCanonicalPal?: (characterId: string) => boolean;
}

type CoreResult<T> = {
  data: T;
  lastParseAt?: string;
  formatDrift?: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_FAILURE_BACKOFF_MS = 5_000;
const DEFAULT_LIVE_DATA_MAX_AGE_MS = 10 * 60_000;

/**
 * One polling/cache boundary for all consumers of the integration API.
 *
 * Player, Pal, and guild responses are committed atomically. Optional live
 * telemetry has a bounded last-good fallback, which is explicitly marked stale.
 */
export class SnapshotService {
  private snapshot: WorldSnapshot | null = null;
  private refreshInFlight: Promise<WorldSnapshot> | null = null;
  private started = false;
  private readonly maxAgeMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly failureBackoffMs: number;
  private readonly liveDataMaxAgeMs: number;
  private readonly now: () => number;
  private readonly resolvePalName?: (characterId: string, rawDisplayName: string) => string;
  private readonly isCanonicalPal?: (characterId: string) => boolean;

  constructor(
    private readonly client: IntegrationClient,
    options: SnapshotServiceOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.failureBackoffMs = options.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
    this.liveDataMaxAgeMs = options.liveDataMaxAgeMs ?? DEFAULT_LIVE_DATA_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.resolvePalName = options.resolvePalName;
    this.isCanonicalPal = options.isCanonicalPal;
  }

  private withResolvedNames(pals: RosterPal[]): RosterPal[] {
    const resolve = this.resolvePalName;
    return pals.map((pal) => {
      const displayName = resolve ? resolve(pal.characterId, pal.displayName) : pal.displayName;
      const canonical = this.isCanonicalPal?.(pal.characterId) === true;
      return { ...pal, displayName, canonical };
    });
  }

  peek(): WorldSnapshot | null {
    return this.snapshot;
  }

  async get(): Promise<WorldSnapshot> {
    const current = this.snapshot;
    if (
      current &&
      this.now() - Date.parse(current.capturedAt) < this.maxAgeMs
    ) {
      return current;
    }

    try {
      return await this.refresh();
    } catch (error) {
      // Availability is preferable to losing every command during a temporary
      // API outage. Consumers can inspect capturedAt to describe staleness.
      if (this.snapshot) return this.snapshot;
      throw error;
    }
  }

  /** Starts at most one background polling loop for this service instance. */
  start(signal: AbortSignal): void {
    if (this.started || signal.aborted) return;
    this.started = true;
    void this.poll(signal);
  }

  private refresh(): Promise<WorldSnapshot> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const pending = this.fetchSnapshot();
    this.refreshInFlight = pending;
    void pending.finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    }).catch(() => {
      // The caller or polling loop owns the original rejection. This prevents
      // the cleanup promise returned by finally() becoming unhandled.
    });
    return pending;
  }

  private async fetchSnapshot(): Promise<WorldSnapshot> {
    const worldSummaryCall = (this.client as IntegrationClient & {
      worldSummary?: IntegrationClient["worldSummary"];
    }).worldSummary;
    const worldWorkersCall = (this.client as IntegrationClient & {
      worldWorkers?: IntegrationClient["worldWorkers"];
    }).worldWorkers;
    const [core, metricsResult, serverResult, worldSummaryResult, worldWorkersResult] = await Promise.all([
      Promise.all([
        this.client.players(),
        this.client.pals(),
        this.client.guilds(),
      ]),
      this.client.metricsCurrent().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      this.client.server().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      typeof worldSummaryCall === "function"
        ? worldSummaryCall.call(this.client).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : Promise.resolve({
            ok: false as const,
            error: new ApiError(404, "unsupported", "world summary endpoint unsupported"),
          }),
      typeof worldWorkersCall === "function"
        ? worldWorkersCall.call(this.client).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : Promise.resolve({
            ok: false as const,
            error: new ApiError(404, "unsupported", "world workers endpoint unsupported"),
          }),
    ]);

    const [players, pals, guilds] = core as [
      CoreResult<PlayerSummary[]>,
      CoreResult<RosterPal[]>,
      CoreResult<Guild[]>,
    ];
    const previous = this.snapshot;
    const now = this.now();
    const server = serverResult.ok
      ? serverResult.value.data
      : previous?.server ?? null;
    // Null means this refresh had no fresh metric sample. Presence can say so,
    // and digest aggregation must not repeatedly count an old value as current.
    const metricsCurrent = metricsResult.ok ? metricsResult.value.data : null;
    const worldSummary = worldSummaryResult.ok
      ? freshLivePayload(worldSummaryResult.value.data, now, this.liveDataMaxAgeMs)
      : fallbackLivePayload(previous?.worldSummary, worldSummaryResult.error, now, this.liveDataMaxAgeMs);
    const liveWorkers = worldWorkersResult.ok
      ? freshLivePayload(worldWorkersResult.value.data, now, this.liveDataMaxAgeMs)
      : fallbackLivePayload(previous?.liveWorkers, worldWorkersResult.error, now, this.liveDataMaxAgeMs);
    const parseTimes = [
      players.lastParseAt,
      pals.lastParseAt,
      guilds.lastParseAt,
    ].filter((value): value is string => value !== undefined);
    if (new Set(parseTimes).size > 1) {
      throw new Error("Integration endpoints returned different save parse generations");
    }

    const next: WorldSnapshot = {
      players: players.data,
      pals: this.withResolvedNames(pals.data),
      guilds: guilds.data,
      metricsCurrent,
      server,
      worldSummary,
      liveWorkers,
      formatDrift:
        players.formatDrift === true ||
        pals.formatDrift === true ||
        guilds.formatDrift === true ||
        serverResult.ok && (
          serverResult.value.formatDrift === true ||
          serverResult.value.data.save?.formatDrift === true
        ),
      lastParseAt:
        parseTimes.length > 0
          ? parseTimes.reduce((latest, value) =>
              Date.parse(value) > Date.parse(latest) ? value : latest,
            )
          : null,
      capturedAt: new Date(now).toISOString(),
    };

    this.snapshot = next;
    return next;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failureCount = 0;
    let announcedReady = false;
    while (!signal.aborted) {
      let delayMs = this.pollIntervalMs;
      try {
        await this.refresh();
        failureCount = 0;
        if (!announcedReady) {
          console.log("[snapshots] ready");
          announcedReady = true;
        }
      } catch (error) {
        failureCount++;
        delayMs =
          error instanceof RateLimitedError
            ? Math.max(1_000, error.retryAfterSec * 1_000)
            : Math.min(
                this.maxBackoffMs,
                this.failureBackoffMs * 2 ** Math.min(failureCount - 1, 6),
              );
        console.warn(`[snapshots] refresh failed (${snapshotErrorLabel(error)}); retrying`);
      }
      await waitFor(delayMs, signal);
    }
  }
}

type LivePayload = Pick<GameDataWorldSummary, "state" | "capturedAt">;

function freshLivePayload<T extends LivePayload>(
  payload: T,
  now: number,
  maxAgeMs: number,
): T | null {
  if (payload.state !== "ready" && payload.state !== "stale") return payload;
  const capturedAt = payload.capturedAt === null ? Number.NaN : Date.parse(payload.capturedAt);
  const ageMs = now - capturedAt;
  return Number.isFinite(capturedAt) && ageMs >= 0 && ageMs <= maxAgeMs ? payload : null;
}

function fallbackLivePayload<T extends LivePayload>(
  previous: T | null | undefined,
  error: unknown,
  now: number,
  maxAgeMs: number,
): T | null {
  if (isTerminalOptionalFailure(error) || !previous) return null;
  const fresh = freshLivePayload(previous, now, maxAgeMs);
  if (!fresh || (fresh.state !== "ready" && fresh.state !== "stale")) return null;
  return { ...fresh, state: "stale" };
}

function isTerminalOptionalFailure(error: unknown): boolean {
  return error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429;
}

function snapshotErrorLabel(error: unknown): string {
  if (error instanceof RateLimitedError) return "rate limited";
  if (error instanceof ApiError) return `panel API ${error.status}`;
  if (error instanceof Error && error.message.includes("parse generations")) {
    return "save advanced during refresh";
  }
  return "temporary error";
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
