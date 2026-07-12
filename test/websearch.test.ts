import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSearchClient, WebSearchError } from "../src/ai/websearch.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WebSearchClient", () => {
  it("rejects a non-http base URL", () => {
    expect(() => new WebSearchClient({ baseUrl: "searx.example.org" })).toThrow();
  });

  it("requests JSON from /search and normalizes results and answers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        query: "meteorite ore Palworld",
        answers: ["Refine at a furnace.", { answer: "Used for high-tier ammo." }, { nope: true }],
        results: [
          { title: "Ore", url: "https://palworld.wiki.gg/wiki/Ore", content: "Mining node.", engine: "google" },
          { title: "No URL" },
          { url: "https://example.com/x", title: "Cited", content: "snippet" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new WebSearchClient({ baseUrl: "https://searx.example.org/" });
    const response = await client.search("meteorite ore Palworld");

    const requested = new URL(fetchMock.mock.calls[0]![0].toString());
    expect(requested.origin + requested.pathname).toBe("https://searx.example.org/search");
    expect(requested.searchParams.get("q")).toBe("meteorite ore Palworld");
    expect(requested.searchParams.get("format")).toBe("json");
    expect(requested.searchParams.get("safesearch")).toBe("1");

    // Results missing url/title are dropped; answers normalize strings and {answer} objects.
    expect(response.results).toEqual([
      { title: "Ore", url: "https://palworld.wiki.gg/wiki/Ore", content: "Mining node.", engine: "google" },
      { title: "Cited", url: "https://example.com/x", content: "snippet", engine: null },
    ]);
    expect(response.answers).toEqual(["Refine at a furnace.", "Used for high-tier ammo."]);
  });

  it("caps the number of returned results", async () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      title: `r${index}`,
      url: `https://example.com/${index}`,
      content: "",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ results, answers: [] })));

    const client = new WebSearchClient({ baseUrl: "https://searx.example.org", maxResults: 3 });
    const response = await client.search("anything");
    expect(response.results).toHaveLength(3);
  });

  it("filters unsafe and duplicate URLs and prefers established Palworld sources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      results: [
        { title: "Generic", url: "https://example.com/item#details" },
        { title: "Unsafe", url: "javascript:alert(1)" },
        { title: "Duplicate", url: "https://example.com/item" },
        { title: "Wiki", url: "https://palworld.wiki.gg/wiki/Item" },
        { title: "Official", url: "https://www.palworldgame.com/news" },
      ],
    })));
    const client = new WebSearchClient({ baseUrl: "https://searx.example.org" });
    const response = await client.search("item");
    expect(response.results.map((result) => result.title)).toEqual(["Official", "Wiki", "Generic"]);
    expect(response.results[2]!.url).toBe("https://example.com/item");
  });

  it("caches normalized equivalent queries and coalesces concurrent requests", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WebSearchClient({ baseUrl: "https://searx.example.org", cacheTtlMs: 60_000 });

    const first = client.search("  Meteorite   Ore ");
    const second = client.search("meteorite ore");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(jsonResponse({ results: [], answers: ["answer"] }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await client.search("METEORITE ORE");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an HTTP error to a typed WebSearchError with the status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403)));
    const client = new WebSearchClient({ baseUrl: "https://searx.example.org" });
    await expect(client.search("q")).rejects.toMatchObject({ code: "http_error", status: 403 });
    await expect(client.search("q")).rejects.toBeInstanceOf(WebSearchError);
  });

  it("aborts a slow lookup at the configured deadline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    ));
    const client = new WebSearchClient({ baseUrl: "https://searx.example.org", timeoutMs: 5 });
    await expect(client.search("slow Palworld")).rejects.toMatchObject({ code: "timeout" });
  });

  it("reuses a mode-0600 disk cache after restart without contacting SearXNG", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palhelm-web-cache-"));
    const cachePath = join(directory, "cache.json");
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        answers: ["cached answer"],
        results: [],
      }));
      vi.stubGlobal("fetch", fetchMock);
      const first = new WebSearchClient({
        baseUrl: "https://searx.example.org",
        cachePath,
        cacheTtlMs: 60_000,
      });
      await expect(first.search("Meteorite Palworld")).resolves.toMatchObject({ cacheStatus: "live" });
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      const restarted = new WebSearchClient({
        baseUrl: "https://searx.example.org",
        cachePath,
        cacheTtlMs: 60_000,
      });
      await expect(restarted.search("meteorite palworld")).resolves.toMatchObject({
        answers: ["cached answer"],
        cacheStatus: "fresh_cache",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serves an explicitly labeled stale result only for retryable offline failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "palhelm-web-stale-"));
    const cachePath = join(directory, "cache.json");
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ answers: ["last good"], results: [] })));
      await new WebSearchClient({
        baseUrl: "https://searx.example.org", cachePath, cacheTtlMs: 1, staleIfErrorMs: 60_000,
      }).search("sulfur Palworld");
      vi.setSystemTime(new Date("2026-07-11T12:00:01Z"));
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      const restarted = new WebSearchClient({
        baseUrl: "https://searx.example.org", cachePath, cacheTtlMs: 1, staleIfErrorMs: 60_000,
      });
      await expect(restarted.search("sulfur Palworld")).resolves.toMatchObject({
        answers: ["last good"], cacheStatus: "stale_cache",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores a corrupt disk cache and replaces it after a successful lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palhelm-web-corrupt-"));
    const cachePath = join(directory, "cache.json");
    try {
      await writeFile(cachePath, "{definitely not json", "utf8");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ answers: ["recovered"], results: [] })));
      const client = new WebSearchClient({ baseUrl: "https://searx.example.org", cachePath });
      await expect(client.search("recovery Palworld")).resolves.toMatchObject({ answers: ["recovered"] });
      expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ schemaVersion: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds durable entries and rejects malformed top-level responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palhelm-web-bound-"));
    const cachePath = join(directory, "cache.json");
    try {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(
        () => Promise.resolve(jsonResponse({ answers: [], results: [] })),
      ));
      const client = new WebSearchClient({
        baseUrl: "https://searx.example.org", cachePath, cacheMaxEntries: 2, cacheMaxBytes: 10_000,
      });
      await client.search("one");
      await client.search("two");
      await client.search("three");
      expect(JSON.parse(await readFile(cachePath, "utf8")).entries).toHaveLength(2);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(["not", "an", "object"])));
      await expect(new WebSearchClient({ baseUrl: "https://searx.example.org" }).search("bad"))
        .rejects.toMatchObject({ code: "malformed_response" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
