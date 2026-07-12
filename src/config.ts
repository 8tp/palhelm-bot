import "dotenv/config";

export interface BotConfig {
  discordToken: string;
  applicationId: string;
  guildId: string;
  /** Display name for this server, shown in command replies and embeds (default: "the server"). */
  serverLabel: string;
  notifyChannelId: string;
  /** Separate channel for chatty join/leave activity so it can be muted independently. */
  activityChannelId: string | null;
  /** Optional dedicated channel for milestone announcements (falls back to notify channel). */
  milestonesChannelId: string | null;
  adminRoleId: string;
  palhelmBaseUrl: string;
  integrationKey: string;
  adminPassword: string;
  notifyEventKinds: Set<string>;
  /** Temporarily mute "world save format drift" notices (NOTIFY_SUPPRESS_DRIFT=true). */
  suppressDriftNotices: boolean;
  /** Directory for restart-safe snapshots, milestone history, and digest state. */
  dataDir: string;
  /** Opt in to guarded history processing while the panel reports format drift. */
  historyAllowFormatDrift: boolean;
  milestonesEnabled: boolean;
  digestEnabled: boolean;
  /** Local-time weekday, where 0 is Sunday. */
  digestWeekday: number;
  /** Local-time hour (0-23). */
  digestHour: number;
  healthAlertsEnabled: boolean;
  /** Optional OpenRouter key; /ask reports unavailable when omitted. */
  openRouterApiKey: string | null;
  openRouterModel: string;
  /** Per OpenRouter round-trip deadline. Tool-using questions can make several calls. */
  aiTimeoutMs: number;
  aiDailyRequestLimit: number;
  aiCooldownSec: number;
  /** Base URL of a self-hosted SearXNG instance; enables /ask web lookups when set. */
  searxngUrl: string | null;
  /** Per SearXNG lookup deadline. */
  webSearchTimeoutMs: number;
  /** In-memory result cache lifetime; zero disables caching. */
  webSearchCacheTtlSec: number;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function loadConfig(): BotConfig {
  const kinds = (process.env.NOTIFY_EVENT_KINDS ?? "backup,system")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return {
    discordToken: required("DISCORD_TOKEN"),
    applicationId: required("DISCORD_APPLICATION_ID"),
    guildId: required("DISCORD_GUILD_ID"),
    serverLabel: process.env.SERVER_LABEL?.trim() || "the server",
    notifyChannelId: required("NOTIFY_CHANNEL_ID"),
    activityChannelId: process.env.ACTIVITY_CHANNEL_ID?.trim() || null,
    milestonesChannelId: process.env.MILESTONES_CHANNEL_ID?.trim() || null,
    adminRoleId: required("ADMIN_ROLE_ID"),
    palhelmBaseUrl: required("PALHELM_BASE_URL").replace(/\/+$/, ""),
    integrationKey: required("PALHELM_INTEGRATION_KEY"),
    adminPassword: required("PALHELM_ADMIN_PASSWORD"),
    notifyEventKinds: new Set(kinds),
    suppressDriftNotices: process.env.NOTIFY_SUPPRESS_DRIFT?.trim() === "true",
    dataDir: process.env.BOT_DATA_DIR?.trim() || "data",
    historyAllowFormatDrift: process.env.HISTORY_ALLOW_FORMAT_DRIFT?.trim() === "true",
    milestonesEnabled: process.env.MILESTONES_ENABLED?.trim() !== "false",
    digestEnabled: process.env.WEEKLY_DIGEST_ENABLED?.trim() === "true",
    digestWeekday: boundedInt("WEEKLY_DIGEST_WEEKDAY", 0, 0, 6),
    digestHour: boundedInt("WEEKLY_DIGEST_HOUR", 18, 0, 23),
    healthAlertsEnabled: process.env.HEALTH_ALERTS_ENABLED?.trim() === "true",
    openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || null,
    openRouterModel: process.env.OPENROUTER_MODEL?.trim() || "deepseek/deepseek-v4-flash",
    aiTimeoutMs: boundedInt("AI_TIMEOUT_MS", 60_000, 5_000, 120_000),
    aiDailyRequestLimit: boundedInt("AI_DAILY_REQUEST_LIMIT", 100, 1, 10_000),
    aiCooldownSec: boundedInt("AI_COOLDOWN_SEC", 30, 0, 3_600),
    searxngUrl: normalizedUrl("SEARXNG_URL"),
    webSearchTimeoutMs: boundedInt("WEB_SEARCH_TIMEOUT_MS", 8_000, 1_000, 30_000),
    webSearchCacheTtlSec: boundedInt("WEB_SEARCH_CACHE_TTL_SEC", 21_600, 0, 604_800),
  };
}

function normalizedUrl(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return raw.replace(/\/+$/, "");
}
