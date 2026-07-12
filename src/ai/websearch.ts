// Palworld-scoped web search backed by a self-hosted SearXNG instance.
// SearXNG aggregates general engines (Google/Bing/DuckDuckGo/etc.) behind one
// JSON endpoint and needs no third-party API key: GET /search?q=..&format=json.
// The instance must enable the `json` format under `search.formats` in its
// settings.yml, otherwise it answers 403 to format=json requests.

import { mkdir, readFile, rename, chmod, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WebSearchResult {
  title: string;
  url: string;
  /** Result snippet; may be empty for some engines. */
  content: string;
  engine: string | null;
}

export interface WebSearchResponse {
  query: string;
  /** Direct answer strings (calculators, instant answers) when engines supply them. */
  answers: string[];
  results: WebSearchResult[];
  /** Lets callers visibly distinguish live, cached, and stale-if-offline knowledge. */
  cacheStatus?: "live" | "fresh_cache" | "stale_cache";
  retrievedAt?: number;
}

export type WebSearchErrorCode =
  | "aborted"
  | "timeout"
  | "network_error"
  | "http_error"
  | "response_too_large"
  | "malformed_response";

/** Safe to log generically; never contains the query or provider bodies. */
export class WebSearchError extends Error {
  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

export interface WebSearchClientOptions {
  /** Base URL of the SearXNG instance, e.g. https://searxng.example.org. */
  baseUrl: string;
  timeoutMs?: number;
  maxResults?: number;
  maxResponseBytes?: number;
  /** Cache successful normalized results in memory; zero disables caching. */
  cacheTtlMs?: number;
  /** Optional restart-safe JSON cache. Its parent directory is created as needed. */
  cachePath?: string;
  /** Maximum normalized queries retained in memory and on disk. */
  cacheMaxEntries?: number;
  /** Hard upper bound for the serialized disk cache. */
  cacheMaxBytes?: number;
  /** How long an expired result may be used only when SearXNG is unavailable. */
  staleIfErrorMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1_000;
const CACHE_SCHEMA_VERSION = 1;

interface CacheEntry {
  expiresAt: number;
  retrievedAt: number;
  response: WebSearchResponse;
}

interface DiskCache {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  entries: Array<CacheEntry & { key: string }>;
}

export class WebSearchClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxResponseBytes: number;
  private readonly cacheTtlMs: number;
  private readonly cachePath: string | null;
  private readonly cacheMaxEntries: number;
  private readonly cacheMaxBytes: number;
  private readonly staleIfErrorMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<WebSearchResponse>>();
  private cacheLoad: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: WebSearchClientOptions) {
    const base = options.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) {
      throw new Error("SearXNG baseUrl must be an http(s) URL");
    }
    this.endpoint = `${base}/search`;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxResults = positiveInteger(options.maxResults ?? DEFAULT_MAX_RESULTS, "maxResults");
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.cacheTtlMs = nonNegativeInteger(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "cacheTtlMs");
    this.cachePath = options.cachePath?.trim() || null;
    this.cacheMaxEntries = positiveInteger(
      options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
      "cacheMaxEntries",
    );
    this.cacheMaxBytes = positiveInteger(
      options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES,
      "cacheMaxBytes",
    );
    this.staleIfErrorMs = nonNegativeInteger(
      options.staleIfErrorMs ?? DEFAULT_STALE_IF_ERROR_MS,
      "staleIfErrorMs",
    );
  }

  async search(query: string, signal?: AbortSignal): Promise<WebSearchResponse> {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (!normalizedQuery) throw new Error("Web search query is required");
    const key = normalizedQuery.toLocaleLowerCase("en-US");
    await this.loadDiskCache();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      // Refresh insertion order so pruning behaves like a small LRU.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return withCacheStatus(cached.response, "fresh_cache", cached.retrievedAt);
    }
    const existing = this.pending.get(key);
    if (existing && !signal) return existing;

    const request = this.fetchSearch(normalizedQuery, signal)
      .then(async (response) => {
        const retrievedAt = Date.now();
        const live = withCacheStatus(response, "live", retrievedAt);
        if (this.cacheTtlMs > 0) {
          this.cache.delete(key);
          this.cache.set(key, {
            expiresAt: retrievedAt + this.cacheTtlMs,
            retrievedAt,
            response: live,
          });
          this.pruneCache();
          await this.persistDiskCache();
        }
        return live;
      })
      .catch((error: unknown) => {
        const now = Date.now();
        if (
          cached &&
          this.staleIfErrorMs > 0 &&
          now <= cached.expiresAt + this.staleIfErrorMs &&
          isRetryableSearchFailure(error)
        ) {
          return withCacheStatus(cached.response, "stale_cache", cached.retrievedAt);
        }
        throw error;
      });
    if (!signal) this.pending.set(key, request);
    try {
      return await request;
    } finally {
      if (!signal && this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  private async fetchSearch(query: string, signal?: AbortSignal): Promise<WebSearchResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();

    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    url.searchParams.set("safesearch", "1");

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body = await readBoundedBody(response, this.maxResponseBytes);
      if (!response.ok) {
        throw new WebSearchError(
          "http_error",
          `SearXNG request failed with HTTP ${response.status}`,
          response.status,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new WebSearchError("malformed_response", "SearXNG returned invalid JSON");
      }
      return this.parse(query, parsed);
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      if (timedOut) throw new WebSearchError("timeout", "SearXNG request timed out");
      if (signal?.aborted) throw new WebSearchError("aborted", "SearXNG request was cancelled");
      throw new WebSearchError("network_error", "SearXNG request failed");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private pruneCache(): void {
    if (this.cache.size <= this.cacheMaxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (
        entry.expiresAt + this.staleIfErrorMs <= now ||
        this.cache.size > this.cacheMaxEntries
      ) this.cache.delete(key);
      if (this.cache.size <= this.cacheMaxEntries) break;
    }
  }

  private async loadDiskCache(): Promise<void> {
    if (!this.cachePath) return;
    if (!this.cacheLoad) this.cacheLoad = this.readDiskCache();
    await this.cacheLoad;
  }

  private async readDiskCache(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.cachePath!, "utf8"));
      const root = asRecord(raw);
      if (root?.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(root.entries)) return;
      const now = Date.now();
      for (const rawEntry of root.entries.slice(-this.cacheMaxEntries)) {
        const entry = parseDiskEntry(rawEntry, this.maxResults);
        if (!entry || entry.expiresAt + this.staleIfErrorMs <= now) continue;
        this.cache.set(entry.key, entry);
      }
      this.pruneCache();
      await chmod(this.cachePath!, 0o600).catch(() => {});
    } catch {
      // Missing, unreadable, or corrupt cache data is never a startup failure.
      this.cache.clear();
    }
  }

  private async persistDiskCache(): Promise<void> {
    if (!this.cachePath) return;
    this.persistQueue = this.persistQueue.then(async () => {
      const path = this.cachePath!;
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        let snapshot = this.diskSnapshot();
        let body = `${JSON.stringify(snapshot)}\n`;
        while (Buffer.byteLength(body) > this.cacheMaxBytes && this.cache.size > 0) {
          const oldest = this.cache.keys().next().value as string | undefined;
          if (!oldest) break;
          this.cache.delete(oldest);
          snapshot = this.diskSnapshot();
          body = `${JSON.stringify(snapshot)}\n`;
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, path);
        // rename preserves the temp file's mode, while chmod also repairs an old
        // permissive cache created by a previous release.
        await chmod(path, 0o600);
      } catch {
        // Search remains available in memory when durable storage is unavailable.
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    await this.persistQueue;
  }

  private diskSnapshot(): DiskCache {
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      entries: [...this.cache.entries()].map(([key, entry]) => ({ key, ...entry })),
    };
  }

  private parse(query: string, value: unknown): WebSearchResponse {
    const root = asRecord(value);
    if (!root) throw new WebSearchError("malformed_response", "SearXNG returned an invalid response");
    const rawResults = Array.isArray(root.results) ? root.results : [];
    const results: WebSearchResult[] = [];
    const seenUrls = new Set<string>();
    for (const entry of rawResults) {
      const record = asRecord(entry);
      if (!record) continue;
      const url = typeof record.url === "string" ? record.url : null;
      const title = typeof record.title === "string" ? record.title : null;
      if (!url || !title) continue;
      const safeUrl = normalizeResultUrl(url);
      if (!safeUrl || seenUrls.has(safeUrl)) continue;
      seenUrls.add(safeUrl);
      results.push({
        title: title.slice(0, 500),
        url: safeUrl,
        content: typeof record.content === "string" ? record.content.slice(0, 4_000) : "",
        engine: typeof record.engine === "string" ? record.engine.slice(0, 100) : null,
      });
    }
    // Prefer first-party and established Palworld references while preserving
    // SearXNG's relevance order within each trust tier.
    results.sort((a, b) => sourceRank(a.url) - sourceRank(b.url));
    results.splice(this.maxResults);
    const answers = Array.isArray(root.answers)
      ? root.answers
          .map((answer) => {
            if (typeof answer === "string") return answer;
            const record = asRecord(answer);
            const text = record?.answer ?? record?.content;
            return typeof text === "string" ? text : null;
          })
          .filter((answer): answer is string => Boolean(answer && answer.trim()))
          .map((answer) => answer.slice(0, 2_000))
          .slice(0, 3)
      : [];
    return { query, answers, results };
  }
}

function withCacheStatus(
  response: WebSearchResponse,
  cacheStatus: NonNullable<WebSearchResponse["cacheStatus"]>,
  retrievedAt: number,
): WebSearchResponse {
  return { ...response, cacheStatus, retrievedAt };
}

function isRetryableSearchFailure(error: unknown): boolean {
  return error instanceof WebSearchError && (
    error.code === "timeout" ||
    error.code === "network_error" ||
    (error.code === "http_error" && (error.status === 429 || (error.status ?? 0) >= 500))
  );
}

function parseDiskEntry(
  value: unknown,
  maxResults: number,
): (CacheEntry & { key: string }) | null {
  const record = asRecord(value);
  if (!record || typeof record.key !== "string" || record.key.length > 500) return null;
  if (!Number.isFinite(record.expiresAt) || !Number.isFinite(record.retrievedAt)) return null;
  const rawResponse = asRecord(record.response);
  if (!rawResponse || typeof rawResponse.query !== "string" || rawResponse.query.length > 500) return null;
  const answers = Array.isArray(rawResponse.answers)
    ? rawResponse.answers.filter((item): item is string => typeof item === "string").slice(0, 3)
    : [];
  const results: WebSearchResult[] = [];
  if (Array.isArray(rawResponse.results)) {
    for (const item of rawResponse.results) {
      const result = asRecord(item);
      if (!result || typeof result.title !== "string" || typeof result.url !== "string") continue;
      const url = normalizeResultUrl(result.url);
      if (!url) continue;
      results.push({
        title: result.title.slice(0, 500),
        url,
        content: typeof result.content === "string" ? result.content.slice(0, 4_000) : "",
        engine: typeof result.engine === "string" ? result.engine.slice(0, 100) : null,
      });
      if (results.length >= maxResults) break;
    }
  }
  return {
    key: record.key,
    expiresAt: Number(record.expiresAt),
    retrievedAt: Number(record.retrievedAt),
    response: { query: rawResponse.query, answers, results },
  };
}

function normalizeResultUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sourceRank(raw: string): number {
  const host = new URL(raw).hostname.toLowerCase();
  if (host === "palworldgame.com" || host.endsWith(".palworldgame.com")) return 0;
  if (host === "pocketpair.jp" || host.endsWith(".pocketpair.jp")) return 0;
  if (host === "palworld.wiki.gg" || host.endsWith(".palworld.wiki.gg")) return 1;
  if (host === "paldb.cc" || host.endsWith(".paldb.cc")) return 2;
  return 3;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw new WebSearchError("response_too_large", "SearXNG response exceeded the allowed size");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
