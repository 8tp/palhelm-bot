import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  DISCORD_TOKEN: "token",
  DISCORD_APPLICATION_ID: "app",
  DISCORD_GUILD_ID: "guild",
  NOTIFY_CHANNEL_ID: "channel",
  ADMIN_ROLE_ID: "role",
  PALHELM_BASE_URL: "http://panel.invalid",
  PALHELM_INTEGRATION_KEY: "phk_test",
  PALHELM_ADMIN_PASSWORD: "password",
};

afterEach(() => vi.unstubAllEnvs());

function stubRequired(): void {
  for (const [name, value] of Object.entries(required)) vi.stubEnv(name, value);
}

describe("loadConfig history drift mode", () => {
  it("is safely disabled by default", () => {
    stubRequired();
    vi.stubEnv("HISTORY_ALLOW_FORMAT_DRIFT", "");
    expect(loadConfig().historyAllowFormatDrift).toBe(false);
  });

  it("requires an explicit true value", () => {
    stubRequired();
    vi.stubEnv("HISTORY_ALLOW_FORMAT_DRIFT", "true");
    expect(loadConfig().historyAllowFormatDrift).toBe(true);
  });
});

describe("loadConfig server label", () => {
  it("uses a product-safe default and accepts an operator label", () => {
    stubRequired();
    vi.stubEnv("SERVER_LABEL", "");
    expect(loadConfig().serverLabel).toBe("Palworld Server");
    vi.stubEnv("SERVER_LABEL", "Friends Server");
    expect(loadConfig().serverLabel).toBe("Friends Server");
  });
});

describe("loadConfig AI reliability", () => {
  it("uses bounded timeout and search-cache defaults", () => {
    stubRequired();
    expect(loadConfig()).toMatchObject({
      aiTimeoutMs: 60_000,
      webSearchTimeoutMs: 8_000,
      webSearchCacheTtlSec: 21_600,
    });
  });

  it("accepts configured values and rejects unsafe deadlines", () => {
    stubRequired();
    vi.stubEnv("AI_TIMEOUT_MS", "45000");
    vi.stubEnv("WEB_SEARCH_TIMEOUT_MS", "5000");
    vi.stubEnv("WEB_SEARCH_CACHE_TTL_SEC", "3600");
    expect(loadConfig()).toMatchObject({
      aiTimeoutMs: 45_000,
      webSearchTimeoutMs: 5_000,
      webSearchCacheTtlSec: 3_600,
    });

    vi.stubEnv("AI_TIMEOUT_MS", "4999");
    expect(() => loadConfig()).toThrow(/AI_TIMEOUT_MS/);
  });
});
