// Client for the read-only Integration API (/api/integration/v1).
// Bearer-key auth, keyset pagination, ETag revalidation, 429 handling.
// Every response here is safe to render into a public Discord channel by design.

import type {
  Guild,
  IntegrationEnvelope,
  IntegrationEvent,
  MapDataset,
  MetricsCurrent,
  Pal,
  PlayerDetail,
  PlayerSummary,
  RosterPal,
  ServerInfo,
} from "../types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class RateLimitedError extends ApiError {
  constructor(readonly retryAfterSec: number) {
    super(429, "rate_limited", `Rate limited; retry in ${retryAfterSec}s`);
    this.name = "RateLimitedError";
  }
}

interface CachedResponse {
  etag: string;
  body: string;
}

export class IntegrationClient {
  // Per-URL ETag cache: a 304 costs the server the same query but saves the
  // body transfer, and is nearly free for a bot polling on a timer.
  private etags = new Map<string, CachedResponse>();

  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
  ) {}

  private async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<IntegrationEnvelope<T>> {
    const url = new URL(`${this.baseUrl}/api/integration/v1${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const cacheKey = url.toString();
    const cached = this.etags.get(cacheKey);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      Accept: "application/json",
    };
    if (cached) headers["If-None-Match"] = cached.etag;

    // Bound every request so one wedged panel connection cannot freeze the
    // shared snapshot refresh (and every command waiting on its first value).
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });

    if (res.status === 304 && cached) {
      return JSON.parse(cached.body) as IntegrationEnvelope<T>;
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After") ?? "5");
      throw new RateLimitedError(Number.isFinite(retry) ? retry : 5);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = "unknown";
      let message = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        code = parsed?.error?.code ?? code;
        message = parsed?.error?.message ?? message;
      } catch {
        // non-JSON error body; keep defaults
      }
      throw new ApiError(res.status, code, message);
    }
    const etag = res.headers.get("ETag");
    if (etag) this.etags.set(cacheKey, { etag, body: text });
    return JSON.parse(text) as IntegrationEnvelope<T>;
  }

  /** Walk every page of a keyset-paginated endpoint. Stops on null nextCursor. */
  private async getAll<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<{ data: T[]; lastParseAt?: string; formatDrift?: boolean }> {
    const out: T[] = [];
    let cursor: string | undefined;
    let lastParseAt: string | undefined;
    // True if any page reported formatDrift. Stays undefined when no page
    // includes the field (older panel) so callers can treat absence as "no signal".
    let formatDrift: boolean | undefined;
    for (;;) {
      const page = await this.get<T[]>(path, { ...params, limit: 500, cursor });
      out.push(...page.data);
      lastParseAt = page.lastParseAt ?? lastParseAt;
      if (page.formatDrift === true) formatDrift = true;
      else if (page.formatDrift === false && formatDrift === undefined) {
        formatDrift = false;
      }
      if (!page.nextCursor) return { data: out, lastParseAt, formatDrift };
      cursor = page.nextCursor;
    }
  }

  players(opts?: { online?: boolean }) {
    return this.getAll<PlayerSummary>("/players", {
      online: opts?.online ? "true" : undefined,
    });
  }

  player(uid: string) {
    return this.get<PlayerDetail>(`/players/${encodeURIComponent(uid)}`);
  }

  pals() {
    return this.getAll<RosterPal>("/pals");
  }

  guilds() {
    return this.get<Guild[]>("/guilds");
  }

  map() {
    return this.get<MapDataset>("/map");
  }

  server() {
    return this.get<ServerInfo>("/server");
  }

  metricsCurrent() {
    return this.get<MetricsCurrent>("/metrics/current");
  }

  /** Bounded, server-redacted activity. Older panels may return ApiError(404). */
  events(limit = 50) {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.get<IntegrationEvent[]>("/events", { limit: bounded });
  }
}

export type { Pal };
