import {
  ChannelType,
  Client,
  Collection,
  GatewayIntentBits,
  MessageFlags,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import type { BotContext, Command } from "./discord/commands.js";
import { errorEmbed } from "./discord/embeds.js";
import { commands } from "./commands/index.js";
import { IntegrationClient, ApiError, RateLimitedError } from "./palhelm/integration.js";
import { SessionClient } from "./palhelm/session.js";
import { startNotifier } from "./notify/events.js";
import { SnapshotService } from "./snapshots/service.js";
import { ObservationTracker } from "./history/tracker.js";
import { startSocialRuntime } from "./history/runtime.js";
import { OpenRouterClient } from "./ai/openrouter.js";
import { WebSearchClient } from "./ai/websearch.js";
import { PalKnowledgeService } from "./knowledge/paldeck.js";
import { resolvePalDisplayName } from "./pals/names.js";
import { baseCharacterId } from "./pals/presentation.js";
import { GoalService } from "./goals/service.js";
import { PlayerLinkService } from "./identity/playerLinks.js";
import { KnowledgeCorpus } from "./knowledge/corpus.js";
import { PalLocationService } from "./knowledge/locations.js";

const config = loadConfig();
const integration = new IntegrationClient(config.palhelmBaseUrl, config.integrationKey);
const knowledge = new PalKnowledgeService(join(config.dataDir, "pal-knowledge.json"));
const generalKnowledge = new KnowledgeCorpus(join(config.dataDir, "general-knowledge-corpus.json"));
const locations = new PalLocationService(join(config.dataDir, "pal-locations.json"));
// Replace raw save identifiers (e.g. "PinkRabbit_Grass", "BOSS_Female_People03")
// with pinned Pal names or humanized NPC labels on every snapshot. Falls back to
// raw/humanized names until the knowledge cache has loaded.
const snapshots = new SnapshotService(integration, {
  resolvePalName: (characterId, rawDisplayName) =>
    resolvePalDisplayName(characterId, rawDisplayName, (baseId) => {
      try {
        return knowledge.getExact(baseId).data;
      } catch {
        return null; // Knowledge cache not ready yet.
      }
    }),
  isCanonicalPal: (characterId) => {
    try {
      return knowledge.getExact(baseCharacterId(characterId)).data !== null;
    } catch {
      return false;
    }
  },
});
const observations = new ObservationTracker(join(config.dataDir, "observations.json"), {
  allowFormatDrift: config.historyAllowFormatDrift,
  resolveCanonicalPal: (characterId) => {
    try {
      const known = knowledge.getExact(baseCharacterId(characterId)).data;
      return known ? { internalId: known.internalId, name: known.name } : null;
    } catch {
      return null;
    }
  },
});
const goals = new GoalService(join(config.dataDir, "goals.json"));
const playerLinks = new PlayerLinkService(join(config.dataDir, "player-links.json"));
const ctx: BotContext = {
  config,
  integration,
  session: new SessionClient(config.palhelmBaseUrl, config.adminPassword),
  snapshots,
  observations,
  knowledge,
  generalKnowledge,
  locations,
  goals,
  playerLinks,
  openRouter: config.openRouterApiKey
    ? new OpenRouterClient({
        apiKey: config.openRouterApiKey,
        model: config.openRouterModel,
        timeoutMs: config.aiTimeoutMs,
        maxRetries: 1,
        maxTokens: 600,
      })
    : null,
  webSearch: config.searxngUrl
    ? new WebSearchClient({
      baseUrl: config.searxngUrl,
      timeoutMs: config.webSearchTimeoutMs,
      cacheTtlMs: config.webSearchCacheTtlSec * 1_000,
      cachePath: join(config.dataDir, "web-search-cache.json"),
    })
    : null,
};
const lifecycle = new AbortController();

const registry = new Collection<string, Command>();
for (const c of commands) registry.set(c.data.name, c);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  try {
    console.log(`[bot] logged in as ${client.user?.tag}`);
    // Canonical Pal knowledge must be ready before observation-state migration
    // and the first snapshot. Otherwise a temporary empty catalogue could make
    // the tracker forget every observed species and announce the whole roster.
    await knowledge.init().then(() => {
      const status = knowledge.status();
      console.log(`[bot] Palworld 1.0 knowledge ready (${status.palCount} pals, ${status.breedingCombinationCount} breeding combinations)`);
    }).catch(() => {
      console.warn("[bot] Palworld knowledge unavailable; /ask will degrade safely");
    });
    await generalKnowledge.init();
    const corpusStatus = generalKnowledge.status();
    console.log(corpusStatus.available
      ? `[bot] general knowledge corpus ready (${corpusStatus.documentCount} sections)`
      : "[bot] general knowledge corpus not installed; using the built-in field guide and web fallback");
    await locations.init();
    const locationStatus = locations.status();
    console.log(locationStatus.available
      ? `[bot] attributed location cache ready (${locationStatus.rowCount} encounter rows)`
      : "[bot] location cache not installed; /dex uses cached web search for drops and locations");
    await observations.init();
    await goals.init();
    await playerLinks.init();
    snapshots.start(lifecycle.signal);
    // Establish a durable, silent baseline before advertising full readiness.
    // get() coalesces with the poll already started above, so this adds no API calls.
    await observations.observe(await snapshots.get());
    const resolveText = async (id: string | null): Promise<TextChannel | NewsChannel | null> => {
      if (!id) return null;
      const ch = await client.channels.fetch(id).catch(() => null);
      return ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
        ? (ch as TextChannel | NewsChannel)
        : null;
    };
    const channel = await resolveText(config.notifyChannelId);
    const activityChannel = await resolveText(config.activityChannelId);
    const milestonesChannel = await resolveText(config.milestonesChannelId);
    if (!channel) {
      console.warn(`[bot] notification channel is not a visible text channel; Discord notifications disabled`);
    }
    if (config.activityChannelId && !activityChannel) {
      console.warn(`[bot] activity channel is not a visible text channel; join/leave feed disabled`);
    }
    if (config.milestonesChannelId && !milestonesChannel) {
      console.warn(`[bot] milestones channel is not a visible text channel; milestones fall back to the notify channel`);
    }
    startNotifier(channel, ctx, lifecycle.signal);
    startSocialRuntime(client, channel, activityChannel, milestonesChannel, ctx, lifecycle.signal);
  } catch (error) {
    // A corrupt/unreadable durable history must fail loudly so systemd can
    // restart the bot; do not leave a deceptively online, half-started client.
    console.error("[bot] startup failed:", error);
    lifecycle.abort();
    client.destroy();
    process.exitCode = 1;
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    lifecycle.abort();
    client.destroy();
  });
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    const cmd = registry.get(interaction.commandName);
    try {
      await cmd?.autocomplete?.(interaction, ctx);
    } catch (err) {
      console.error(`[bot] autocomplete ${interaction.commandName} failed:`, err);
    }
    return;
  }
  if (interaction.isMessageComponent()) {
    // Collectors own live controls. After a restart their in-memory collector is
    // gone, so provide an explicit stale response instead of letting Discord's
    // interaction spinner time out. The short delay lets a live collector win.
    if (/^(dex_section|records_section|breed_(?:prev|next)|history_(?:prev|next)|box_(?:prev|next)):/u.test(interaction.customId)) {
      setTimeout(() => {
        if (interaction.replied || interaction.deferred) return;
        void interaction.reply({
          content: "That control expired when Palhelm restarted. Run the command again to open a fresh view.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }, 750);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const cmd = registry.get(interaction.commandName);
  if (!cmd) return;

  if (cmd.adminOnly) {
    const roles = interaction.member?.roles;
    const has =
      roles && "cache" in roles
        ? roles.cache.has(config.adminRoleId)
        : Array.isArray(roles)
          ? roles.includes(config.adminRoleId)
          : false;
    if (!has) {
      await interaction.reply({
        embeds: [errorEmbed("You need the server-admin role to run this command.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  try {
    await cmd.execute(interaction, ctx);
  } catch (err) {
    const msg =
      err instanceof RateLimitedError
        ? `The panel is rate-limiting the bot — try again in ~${err.retryAfterSec}s.`
        : err instanceof ApiError
          ? `Panel API error: ${err.message}`
          : "Something went wrong talking to the panel.";
    console.error(`[bot] /${interaction.commandName} failed:`, err);
    const payload = { embeds: [errorEmbed(msg)] };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(config.discordToken);
