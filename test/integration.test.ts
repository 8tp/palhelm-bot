import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  IntegrationClient,
  RateLimitedError,
} from "../src/palhelm/integration.js";
import { closeServer, startServer } from "./http-server.js";

describe("IntegrationClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it("sends bearer authorization and parses envelopes", async () => {
    let authorization: string | undefined;
    const started = await startServer((request, response) => {
      authorization = request.headers.authorization;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: { name: "Test", state: "running" } }));
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "phk_secret").server();

    expect(authorization).toBe("Bearer phk_secret");
    expect(result.data).toMatchObject({ name: "Test", state: "running" });
  });

  it("loads bounded redacted event history from the public integration surface", async () => {
    let requested = "";
    const started = await startServer((request, response) => {
      requested = request.url ?? "";
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        data: [{ at: "2026-07-11T12:00:00Z", kind: "backup", message: "Backup completed" }],
      }));
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "key").events(500);
    expect(requested).toBe("/api/integration/v1/events?limit=100");
    expect(result.data).toEqual([
      { at: "2026-07-11T12:00:00Z", kind: "backup", message: "Backup completed" },
    ]);
  });

  it("loads the aggregate-only Game Data API world summary", async () => {
    let requested = "";
    const started = await startServer((request, response) => {
      requested = request.url ?? "";
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        data: {
          state: "ready", capturedAt: "2026-07-15T12:00:00Z", lastAttemptAt: "2026-07-15T12:00:00Z",
          fps: 59, fpsAvg: 59.2,
          counts: { players: 0, partyPals: 0, basePals: 27, wildPals: 0, npcs: 0, palBoxes: 20, unknown: 0 },
        },
      }));
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "key").worldSummary();

    expect(requested).toBe("/api/integration/v1/world/summary");
    expect(result.data).toMatchObject({ state: "ready", counts: { basePals: 27, palBoxes: 20 } });
  });

  it("loads world workers with bearer auth and revalidates the endpoint with ETag", async () => {
    const validators: Array<string | undefined> = [];
    const authorizations: Array<string | undefined> = [];
    const paths: string[] = [];
    let calls = 0;
    const started = await startServer((request, response) => {
      calls++;
      paths.push(request.url ?? "");
      authorizations.push(request.headers.authorization);
      validators.push(request.headers["if-none-match"]);
      if (calls === 1) {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("ETag", '"workers-v1"');
        response.end(JSON.stringify({
          data: {
            state: "ready",
            capturedAt: "2026-07-15T12:00:00Z",
            workers: [{
              instanceId: "worker-1", characterId: "Anubis", displayName: "Anubis",
              isBoss: false, level: 35, hpPercent: 100, active: true, activity: "working", baseId: "base-1",
            }],
          },
        }));
      } else {
        response.statusCode = 304;
        response.end();
      }
    });
    server = started.server;
    const client = new IntegrationClient(started.baseUrl, "test-key");

    const first = await client.worldWorkers();
    const second = await client.worldWorkers();

    expect(paths).toEqual([
      "/api/integration/v1/world/workers",
      "/api/integration/v1/world/workers",
    ]);
    expect(authorizations).toEqual(["Bearer test-key", "Bearer test-key"]);
    expect(validators).toEqual([undefined, '"workers-v1"']);
    expect(first.data.workers[0]).toMatchObject({ characterId: "Anubis", activity: "working" });
    expect(second).toEqual(first);
  });

  it("walks pagination until nextCursor is null", async () => {
    const cursors: Array<string | null> = [];
    const started = await startServer((request, response) => {
      const url = new URL(request.url ?? "", started.baseUrl);
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          cursor === null
            ? {
                data: [{ uid: "one" }],
                nextCursor: "page-2",
                lastParseAt: "first",
                formatDrift: false,
              }
            : {
                data: [{ uid: "two" }],
                nextCursor: null,
                lastParseAt: "second",
                formatDrift: false,
              },
        ),
      );
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "key").players();

    expect(cursors).toEqual([null, "page-2"]);
    expect(result.data.map((player) => player.uid)).toEqual(["one", "two"]);
    expect(result.lastParseAt).toBe("second");
    expect(result.formatDrift).toBe(false);
  });

  it("propagates formatDrift from a single page", async () => {
    const started = await startServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ uid: "solo" }],
          nextCursor: null,
          lastParseAt: "2026-01-01T00:00:00Z",
          formatDrift: true,
        }),
      );
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "key").players();

    expect(result.data).toHaveLength(1);
    expect(result.formatDrift).toBe(true);
    expect(result.lastParseAt).toBe("2026-01-01T00:00:00Z");
  });

  it("surfaces formatDrift when any page of a multi-page walk reports it", async () => {
    const started = await startServer((request, response) => {
      const url = new URL(request.url ?? "", started.baseUrl);
      const cursor = url.searchParams.get("cursor");
      response.setHeader("Content-Type", "application/json");
      // Only the second page flags drift — the walk must still surface true.
      response.end(
        JSON.stringify(
          cursor === null
            ? {
                data: [{ uid: "one" }],
                nextCursor: "page-2",
                lastParseAt: "first",
                formatDrift: false,
              }
            : {
                data: [{ uid: "two" }],
                nextCursor: null,
                lastParseAt: "second",
                formatDrift: true,
              },
        ),
      );
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "key").players();

    expect(result.data.map((player) => player.uid)).toEqual(["one", "two"]);
    expect(result.formatDrift).toBe(true);
  });

  it("leaves formatDrift undefined when the panel omits the field (older panel)", async () => {
    const started = await startServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ uid: "legacy" }],
          nextCursor: null,
          lastParseAt: "old",
        }),
      );
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "key").players();

    expect(result.formatDrift).toBeUndefined();
  });

  it("passes through formatDrift on single-object envelopes", async () => {
    const started = await startServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: { uid: "p1", name: "Ada", pals: [] },
          lastParseAt: "2026-01-02T00:00:00Z",
          formatDrift: true,
        }),
      );
    });
    server = started.server;

    const result = await new IntegrationClient(started.baseUrl, "key").player(
      "p1",
    );

    expect(result.formatDrift).toBe(true);
    expect(result.data.uid).toBe("p1");
  });

  it("revalidates with ETag and returns the cached body on 304", async () => {
    const validators: Array<string | undefined> = [];
    let calls = 0;
    const started = await startServer((request, response) => {
      calls++;
      validators.push(request.headers["if-none-match"]);
      if (calls === 1) {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("ETag", '"server-v1"');
        response.end(JSON.stringify({ data: { name: "Cached server" } }));
      } else {
        response.statusCode = 304;
        response.end();
      }
    });
    server = started.server;
    const client = new IntegrationClient(started.baseUrl, "key");

    const first = await client.server();
    const second = await client.server();

    expect(validators).toEqual([undefined, '"server-v1"']);
    expect(second).toEqual(first);
  });

  it("throws RateLimitedError with parsed Retry-After seconds", async () => {
    const started = await startServer((_request, response) => {
      response.statusCode = 429;
      response.setHeader("Retry-After", "17");
      response.end();
    });
    server = started.server;

    const error = await new IntegrationClient(started.baseUrl, "key")
      .server()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSec: 17,
    });
  });

  it("maps an error envelope to ApiError fields", async () => {
    const started = await startServer((_request, response) => {
      response.statusCode = 403;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ error: { code: "denied", message: "No access" } }),
      );
    });
    server = started.server;

    const error = await new IntegrationClient(started.baseUrl, "key")
      .server()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "denied", message: "No access" });
  });
});
