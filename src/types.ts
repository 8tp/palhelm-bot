// Shapes mirror docs/API.md. Integration surface types are the redacted
// "safe for public Discord" subset — do not add fields the API never sends.

// ---------- Integration API (/api/integration/v1, bearer phk_ keys) ----------

export interface IntegrationEnvelope<T> {
  data: T;
  /** Only on save-derived endpoints (/players, /players/{uid}, /pals, /guilds). */
  lastParseAt?: string;
  /**
   * Save-derived endpoints only. True when the panel couldn't fully parse this
   * Palworld save version — data may be incomplete or missing. Optional for
   * older panels that don't send the field yet.
   */
  formatDrift?: boolean;
  /** Only on paginated endpoints; null when the walk is done. */
  nextCursor?: string | null;
}

export interface PlayerSummary {
  uid: string;
  name: string;
  online: boolean;
  level: number;
  guildId: string | null;
  guildName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  playtimeSec: number;
  /** Lifetime RecordData fields; absent when an older panel or player save cannot provide them. */
  captureTotal?: number;
  uniquePalsCaptured?: number;
  paldeckUnlocked?: number;
}

export interface Pal {
  instanceId: string;
  characterId: string;
  displayName: string;
  level: number;
  isAlpha: boolean;
  isLucky: boolean;
  /** Optional while older panels do not expose party/box placement. */
  inParty?: boolean;
  partySlot?: number | null;
  boxPage?: number | null;
  boxSlot?: number | null;
  /** Safe derived placement from newer panels; raw container GUIDs are never exposed. */
  placement?: "party" | "box" | "base" | "unknown";
  /** Joins guilds[].bases[].id when placement is base. */
  baseId?: string | null;
  /** Rich per-instance save fields; absent until the corresponding panel contract is deployed. */
  hp?: number;
  gender?: "male" | "female" | "unknown";
  talents?: { hp?: number | null; melee?: number | null; shot?: number | null; defense?: number | null };
  passiveSkillIds?: string[];
  equippedSkillIds?: string[];
}

export interface PlayerDetail extends PlayerSummary {
  pals: Pal[];
}

export interface RosterPal extends Pal {
  ownerUid: string;
  ownerName: string;
  /** Present on newer panels; older panels omit both fields. */
  ownerSource?: "save" | "personal_container" | "last_observed" | "unresolved";
  ownerResolved?: boolean;
  /** Bot-local snapshot annotation; never part of the public panel contract. */
  canonical?: boolean;
}

export interface GuildMember {
  uid: string;
  name: string;
}

export interface GuildBase {
  id: string;
  location: { x: number; y: number };
  level: number;
}

export interface Guild {
  id: string;
  name: string;
  adminUid: string;
  memberCount: number;
  members: GuildMember[];
  bases: GuildBase[];
}

export interface MapLayerTransform {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface MapLayer {
  id: string;
  label: string;
  format: string;
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  transform: MapLayerTransform;
  bounds: unknown;
}

export interface MapDataset {
  source: string;
  gameVersion: string;
  fetchedAt: string;
  notes: string;
  layers: MapLayer[];
}

/** Save-parse summary on GET /server. Absent on older panels. */
export interface ServerSaveInfo {
  state: "ok" | "drift" | "unknown";
  formatDrift: boolean;
  lastParseAt: string | null;
  players: number;
  pals: number;
  guilds: number;
}

export interface ServerInfo {
  name: string;
  description: string;
  version: string;
  state: string;
  uptimeSec: number;
  /** Present on newer panels; omit handling when missing (older panel). */
  save?: ServerSaveInfo;
}

export interface MetricsCurrent {
  fps: number;
  fpsAvg: number;
  frameTimeMs: number;
  players: number;
  maxPlayers: number;
  day: number;
  uptimeSec: number;
  baseCamps: number;
}

/** Aggregate-only Game Data API cache exposed by GET /world/summary. */
export interface GameDataWorldSummary {
  state: "disabled" | "pending" | "ready" | "stale" | "unsupported" | "unauthorized" | "unavailable";
  capturedAt: string | null;
  lastAttemptAt: string | null;
  fps: number;
  fpsAvg: number;
  counts: {
    players: number;
    partyPals: number;
    basePals: number;
    wildPals: number;
    npcs: number;
    palBoxes: number;
    unknown: number;
  };
  activity?: LiveWorkerActivityCounts;
  linkedBasePals?: number;
}

export interface LiveWorkerActivityCounts {
  working: number;
  transporting: number;
  eating: number;
  sleeping: number;
  idle: number;
  inactive: number;
  combat: number;
  incapacitated: number;
  moving: number;
  unknown: number;
}

export interface LiveBaseWorker {
  instanceId: string;
  characterId: string;
  displayName: string;
  isBoss: boolean;
  level: number;
  hpPercent: number | null;
  active: boolean | null;
  activity: keyof LiveWorkerActivityCounts;
  baseId: string;
  ownerUid?: string;
  ownerName?: string;
  ownerSource?: string;
}

export interface GameDataWorldWorkers {
  state: GameDataWorldSummary["state"];
  capturedAt: string | null;
  workers: LiveBaseWorker[];
}

/** Strictly redacted recent activity from GET /api/integration/v1/events. */
export interface IntegrationEvent {
  at: string;
  kind: "join" | "leave" | "backup" | "system";
  message: string;
}

// ---------- Session API (/api/v1, cookie auth) — only what the bot uses ----------

export interface Backup {
  id: string;
  file: string;
  createdAt: string;
  sizeBytes: number;
  trigger: "scheduled" | "manual" | "pre-restore" | "imported";
  worldDay?: number;
}

export interface BackupSchedule {
  enabled: boolean;
  everyMinutes: number;
  keepDays: number;
  nextRunAt: string | null;
}

export type EventKind =
  | "join"
  | "leave"
  | "backup"
  | "system"
  | "panel"
  | "config";

export interface PanelEvent {
  at: string;
  kind: EventKind;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  error: { code: string; message: string; [k: string]: unknown };
}
