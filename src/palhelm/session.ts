// Client for the session-cookie API (/api/v1) — the parts the read-only
// Integration API cannot cover: triggering backups, announcements, the SSE
// event stream that powers Discord notifications, and binary game assets
// (map tiles, pal icons). Logs in with the panel admin password and
// re-authenticates once on 401.

import { setTimeout as delay } from "node:timers/promises";
import type { Backup, BackupSchedule, PanelEvent } from "../types.js";
import { ApiError } from "./integration.js";

export interface BinaryAsset {
  buffer: Buffer;
  contentType: string;
}

export interface SseMessage {
  event: string;
  data: string;
}

/** Minimal player shape from the session API, which (unlike the integration API)
 *  carries live world location for map rendering. */
export interface SessionPlayer {
  uid: string;
  name: string;
  online: boolean;
  location: { x: number; y: number } | null;
}

export interface PlayerSession {
  joinAt: string;
  leaveAt: string | null;
}

export class SessionClient {
  private cookie: string | null = null;
  private loggingIn: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly password: string,
  ) {}

  private async login(): Promise<void> {
    // Coalesce concurrent 401 retries into one login flight.
    this.loggingIn ??= (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: this.password }),
        });
        if (!res.ok) {
          throw new ApiError(res.status, "login_failed", "Panel login failed — check PALHELM_ADMIN_PASSWORD");
        }
        const setCookie = res.headers.get("set-cookie");
        if (!setCookie) throw new ApiError(500, "no_cookie", "Login succeeded but no session cookie was set");
        this.cookie = setCookie.split(";", 1)[0] ?? null;
        const body = (await res.json()) as { role?: string };
        if (body.role !== "admin") {
          throw new ApiError(403, "not_admin", "Panel login succeeded but the role is not admin; backups and announcements need the admin password");
        }
      } finally {
        this.loggingIn = null;
      }
    })();
    return this.loggingIn;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<Response> {
    if (!this.cookie) await this.login();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      this.cookie = null;
      await this.login();
      return this.request(method, path, body, true);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
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
    return JSON.parse(text) as T;
  }

  createBackup(): Promise<Backup> {
    return this.json<Backup>("POST", "/api/v1/backups");
  }

  listBackups(): Promise<Backup[]> {
    return this.json<Backup[]>("GET", "/api/v1/backups");
  }

  /** Players with live world location — used to plot player markers on /map. */
  players(): Promise<SessionPlayer[]> {
    return this.json<SessionPlayer[]>("GET", "/api/v1/players");
  }

  /** Authoritative connection intervals for restart-safe activity duration backfill. */
  async playerSessions(uid: string): Promise<PlayerSession[]> {
    const detail = await this.json<{ sessions?: PlayerSession[] }>("GET", `/api/v1/players/${encodeURIComponent(uid)}`);
    return Array.isArray(detail.sessions) ? detail.sessions : [];
  }

  backupSchedule(): Promise<BackupSchedule> {
    return this.json<BackupSchedule>("GET", "/api/v1/backups/schedule");
  }

  announce(message: string): Promise<void> {
    return this.json<void>("POST", "/api/v1/server/announce", { message });
  }

  recentEvents(limit = 100, kind?: string): Promise<PanelEvent[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (kind) q.set("kind", kind);
    return this.json<PanelEvent[]>("GET", `/api/v1/events?${q}`);
  }

  /**
   * Fetch a session-authed binary asset (map tile, pal icon).
   * Returns null on 404 (asset pyramids are operator-fetched and may be absent).
   */
  async binary(path: string): Promise<BinaryAsset | null> {
    const res = await this.request("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ApiError(res.status, "asset_error", `Asset fetch ${path} failed with HTTP ${res.status}`);
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Consume /api/v1/events/stream (SSE) forever, invoking onMessage per event.
   * Reconnects with capped exponential backoff until the signal aborts.
   */
  async streamEvents(
    onMessage: (msg: SseMessage) => void,
    signal: AbortSignal,
    onStatus?: (status: "connected" | "disconnected", detail?: string) => void,
  ): Promise<void> {
    let backoffMs = 1000;
    while (!signal.aborted) {
      try {
        if (!this.cookie) await this.login();
        const res = await fetch(`${this.baseUrl}/api/v1/events/stream`, {
          headers: {
            Accept: "text/event-stream",
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          },
          signal,
        });
        if (res.status === 401) {
          this.cookie = null;
          continue;
        }
        if (!res.ok || !res.body) {
          throw new Error(`event stream HTTP ${res.status}`);
        }
        onStatus?.("connected");
        backoffMs = 1000;
        await this.readSse(res.body, onMessage, signal);
        onStatus?.("disconnected", "stream ended");
      } catch (err) {
        if (signal.aborted) return;
        onStatus?.("disconnected", err instanceof Error ? err.message : String(err));
      }
      if (signal.aborted) return;
      await delay(backoffMs, undefined, { signal }).catch(() => {});
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  private async readSse(
    body: ReadableStream<Uint8Array>,
    onMessage: (msg: SseMessage) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let event = "message";
    let data: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) return;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") {
            if (data.length > 0) onMessage({ event, data: data.join("\n") });
            event = "message";
            data = [];
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).trimStart());
          }
          // comments (":") and other fields are ignored
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
