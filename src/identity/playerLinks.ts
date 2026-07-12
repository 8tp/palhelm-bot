import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PlayerLink {
  guildId: string;
  discordUserId: string;
  playerUid: string;
  playerName: string;
  linkedAt: string;
  linkedBy: string;
  method: "self" | "admin";
}

interface PlayerLinkState {
  version: 1;
  links: PlayerLink[];
}

export class PlayerLinkService {
  private state: PlayerLinkState | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly statePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async init(): Promise<void> {
    await this.withLock(async () => {
      if (this.state) return;
      try {
        this.state = validateState(JSON.parse(await readFile(this.statePath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = { version: 1, links: [] };
        await this.persist();
      }
    });
  }

  get(guildId: string, discordUserId: string): PlayerLink | null {
    const link = this.requireState().links.find(
      (candidate) => candidate.guildId === guildId && candidate.discordUserId === discordUserId,
    );
    return link ? structuredClone(link) : null;
  }

  getByPlayer(guildId: string, playerUid: string): PlayerLink | null {
    const normalized = playerUid.trim().toLocaleLowerCase("en-US");
    const link = this.requireState().links.find(
      (candidate) => candidate.guildId === guildId && candidate.playerUid.toLocaleLowerCase("en-US") === normalized,
    );
    return link ? structuredClone(link) : null;
  }

  list(guildId: string): PlayerLink[] {
    return this.requireState().links
      .filter((candidate) => candidate.guildId === guildId)
      .map((candidate) => structuredClone(candidate));
  }

  /** Self-service claim. The target must not belong to another Discord member. */
  async claim(input: {
    guildId: string;
    discordUserId: string;
    playerUid: string;
    playerName: string;
  }): Promise<PlayerLink> {
    return this.withLock(async () => {
      const state = this.requireState();
      const occupied = state.links.find(
        (candidate) => candidate.guildId === input.guildId &&
          candidate.playerUid.toLocaleLowerCase("en-US") === input.playerUid.trim().toLocaleLowerCase("en-US") &&
          candidate.discordUserId !== input.discordUserId,
      );
      if (occupied) throw new Error("player_claimed");
      state.links = state.links.filter(
        (candidate) => !(candidate.guildId === input.guildId && candidate.discordUserId === input.discordUserId),
      );
      const link = makeLink({ ...input, linkedBy: input.discordUserId, method: "self" }, this.now());
      state.links.push(link);
      await this.persist();
      return structuredClone(link);
    });
  }

  /** Admin assignment intentionally replaces both sides of a conflicting link. */
  async assign(input: {
    guildId: string;
    discordUserId: string;
    playerUid: string;
    playerName: string;
    linkedBy: string;
  }): Promise<PlayerLink> {
    return this.withLock(async () => {
      const state = this.requireState();
      const playerUid = input.playerUid.trim().toLocaleLowerCase("en-US");
      state.links = state.links.filter((candidate) => !(
        candidate.guildId === input.guildId &&
        (candidate.discordUserId === input.discordUserId || candidate.playerUid.toLocaleLowerCase("en-US") === playerUid)
      ));
      const link = makeLink({ ...input, method: "admin" }, this.now());
      state.links.push(link);
      await this.persist();
      return structuredClone(link);
    });
  }

  async unlink(guildId: string, discordUserId: string): Promise<PlayerLink | null> {
    return this.withLock(async () => {
      const state = this.requireState();
      const index = state.links.findIndex(
        (candidate) => candidate.guildId === guildId && candidate.discordUserId === discordUserId,
      );
      if (index < 0) return null;
      const [removed] = state.links.splice(index, 1);
      await this.persist();
      return structuredClone(removed!);
    });
  }

  private requireState(): PlayerLinkState {
    if (!this.state) throw new Error("PlayerLinkService is not initialized");
    return this.state;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.requireState())}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.statePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function makeLink(
  input: Omit<PlayerLink, "linkedAt">,
  now: Date,
): PlayerLink {
  return {
    ...input,
    guildId: input.guildId.trim(),
    discordUserId: input.discordUserId.trim(),
    playerUid: input.playerUid.trim(),
    playerName: input.playerName.trim(),
    linkedBy: input.linkedBy.trim(),
    linkedAt: now.toISOString(),
  };
}

function validateState(value: unknown): PlayerLinkState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid player-link state");
  const candidate = value as Partial<PlayerLinkState>;
  if (candidate.version !== 1 || !Array.isArray(candidate.links)) throw new Error("Invalid player-link state");
  const seenDiscord = new Set<string>();
  const seenPlayers = new Set<string>();
  const links = candidate.links.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid player link");
    const link = raw as Partial<PlayerLink>;
    for (const field of ["guildId", "discordUserId", "playerUid", "playerName", "linkedAt", "linkedBy"] as const) {
      if (typeof link[field] !== "string" || link[field]!.trim() === "") throw new Error("Invalid player link");
    }
    if (link.method !== "self" && link.method !== "admin") throw new Error("Invalid player link");
    if (!Number.isFinite(Date.parse(link.linkedAt!))) throw new Error("Invalid player link");
    const discordKey = `${link.guildId}:${link.discordUserId}`;
    const playerKey = `${link.guildId}:${link.playerUid!.toLocaleLowerCase("en-US")}`;
    if (seenDiscord.has(discordKey) || seenPlayers.has(playerKey)) throw new Error("Duplicate player link");
    seenDiscord.add(discordKey);
    seenPlayers.add(playerKey);
    return link as PlayerLink;
  });
  return { version: 1, links };
}
