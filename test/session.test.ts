import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SessionClient } from "../src/palhelm/session.js";
import { closeServer, readJson, startServer } from "./http-server.js";

describe("SessionClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it("logs in with the password, stores the cookie, and sends it later", async () => {
    let loginBody: unknown;
    let requestCookie: string | undefined;
    let loginCount = 0;
    const started = await startServer(async (request, response) => {
      if (request.url === "/api/v1/auth/login") {
        loginCount++;
        loginBody = await readJson(request);
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Set-Cookie", "palhelm=session-one; Path=/; HttpOnly");
        response.end(JSON.stringify({ role: "admin" }));
        return;
      }
      requestCookie = request.headers.cookie;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify([]));
    });
    server = started.server;
    const client = new SessionClient(started.baseUrl, "correct horse");

    await client.listBackups();
    await client.listBackups();

    expect(loginBody).toEqual({ password: "correct horse" });
    expect(loginCount).toBe(1);
    expect(requestCookie).toBe("palhelm=session-one");
  });

  it("re-logs in exactly once after a mid-session 401 and retries", async () => {
    let loginCount = 0;
    let backupRequests = 0;
    const cookies: Array<string | undefined> = [];
    const started = await startServer((request, response) => {
      if (request.url === "/api/v1/auth/login") {
        loginCount++;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Set-Cookie", `sid=session-${loginCount}; Path=/`);
        response.end(JSON.stringify({ role: "admin" }));
        return;
      }
      backupRequests++;
      cookies.push(request.headers.cookie);
      if (backupRequests === 2) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { code: "expired", message: "Expired" } }));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify([]));
    });
    server = started.server;
    const client = new SessionClient(started.baseUrl, "password");

    await client.listBackups();
    await client.listBackups();

    expect(loginCount).toBe(2);
    expect(backupRequests).toBe(3);
    expect(cookies).toEqual([
      "sid=session-1",
      "sid=session-1",
      "sid=session-2",
    ]);
  });

  it("returns null for a missing binary and bytes with content type on success", async () => {
    const payload = Buffer.from([0, 1, 2, 255]);
    const started = await startServer((request, response) => {
      if (request.url === "/api/v1/auth/login") {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Set-Cookie", "sid=binary; Path=/");
        response.end(JSON.stringify({ role: "admin" }));
      } else if (request.url === "/missing.png") {
        response.statusCode = 404;
        response.end();
      } else {
        response.setHeader("Content-Type", "image/png");
        response.end(payload);
      }
    });
    server = started.server;
    const client = new SessionClient(started.baseUrl, "password");

    expect(await client.binary("/missing.png")).toBeNull();
    const result = await client.binary("/image.png");

    expect(result?.contentType).toBe("image/png");
    expect(result?.buffer).toEqual(payload);
  });
});
