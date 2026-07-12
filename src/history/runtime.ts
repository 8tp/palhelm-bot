import type { Client, NewsChannel, TextChannel } from "discord.js";
import { ActivityType, AttachmentBuilder, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { BotContext } from "../discord/commands.js";
import { COLOR_NOTICE, COLOR_PRIMARY, formatDuration, truncate } from "../discord/embeds.js";
import { isDeliverableMilestone, type Milestone, type WeeklyDigest } from "./tracker.js";
import type { GoalCompletion } from "../goals/service.js";
import type { WorldSnapshot } from "../snapshots/service.js";
import { HealthWatch, type HealthNotice } from "../health/watch.js";
import { join } from "node:path";
import { ActivityTracker, activitySeedsFromEvents } from "./activity.js";
import { assetsFor } from "../discord/palrender.js";
import { renderMilestoneCard } from "./milestoneCard.js";

const OBSERVE_INTERVAL_MS = 10_000;
const PRESENCE_INTERVAL_MS = 60_000;
const MAX_MILESTONE_LINES = 18;
const MAX_MILESTONE_CARDS = 4;

export function startSocialRuntime(
  client: Client,
  channel: TextChannel | NewsChannel | null,
  activityChannel: TextChannel | NewsChannel | null,
  milestonesChannel: TextChannel | NewsChannel | null,
  ctx: BotContext,
  signal: AbortSignal,
): void {
  // Milestones get their own channel when configured; everything else (digest,
  // health, goals) stays on the main notification channel.
  const milestoneChannel = milestonesChannel ?? channel;
  console.log("[social] runtime started");
  let lastPresence = "";
  const healthWatch = new HealthWatch({ statePath: join(ctx.config.dataDir, "health-watch.json") });
  const activityTracker = new ActivityTracker(join(ctx.config.dataDir, "activity-sessions.json"));
  // One bounded startup read can recover a join that happened before this bot
  // feature/restart. Durable state remains authoritative on later restarts.
  let activitySeeds: Promise<Map<string, number>> | null = null;
  let activityBaselinePending = true;

  const announceActivity = async (snapshot: WorldSnapshot): Promise<void> => {
    if (!activityChannel) return;
    const now = Date.now();
    const online = new Set(snapshot.players.filter((player) => player.online).map((player) => player.uid));
    const changes = await activityTracker.observe(
      snapshot,
      now,
      activityBaselinePending
        ? await (activitySeeds ??= authoritativeActivitySeeds(snapshot, ctx))
        : new Map(),
    );
    activityBaselinePending = false;
    const joins: string[] = [];
    const leaves: string[] = [];
    for (const change of changes) {
      if (change.kind === "join") joins.push(`🟢 **${truncate(change.name, 60)}** came online`);
      else {
        const played = change.durationSec === null ? "" : ` · played ${formatDuration(change.durationSec)}`;
        leaves.push(`🔴 **${truncate(change.name, 60)}** went offline${played}`);
      }
    }
    if (joins.length === 0 && leaves.length === 0) return;
    await activityChannel
      .send({ embeds: [activityEmbed(joins, leaves, online.size, snapshot.metricsCurrent?.maxPlayers ?? null)] })
      .catch((error) => console.error("[social] activity post failed:", error));
  };

  const observe = async (): Promise<void> => {
    const snapshot = ctx.snapshots.peek();
    if (!snapshot) return;
    if (activityChannel) await announceActivity(snapshot);
    await ctx.observations.observe(snapshot);
    await ctx.goals.observe(snapshot);
    if (channel && ctx.config.healthAlertsEnabled) {
      for (const notice of await healthWatch.observe(snapshot, ctx.observations.lastBackupAt())) {
        await channel.send({ embeds: [healthNoticeEmbed(notice, ctx.config.serverLabel)] });
      }
    }
    const pendingMilestones = ctx.observations.nextMilestoneBatch();
    if (pendingMilestones && !ctx.config.milestonesEnabled) {
      await ctx.observations.ackMilestoneBatch(pendingMilestones.id);
    } else if (milestoneChannel && pendingMilestones) {
      const deliverable = pendingMilestones.milestones.filter(isDeliverableMilestone);
      if (deliverable.length > 0) {
        await sendMilestones(milestoneChannel, deliverable, ctx);
      }
      await ctx.observations.ackMilestoneBatch(pendingMilestones.id);
    }
    if (channel && ctx.config.digestEnabled) {
      const now = new Date();
      let pending = ctx.observations.nextPendingDigest();
      if (!pending && digestDue(now, ctx.config.digestWeekday, ctx.config.digestHour)) {
        pending = await ctx.observations.prepareDigest(localDateKey(now), snapshot);
      }
      if (pending) {
        await channel.send({ embeds: [digestEmbed(pending.digest, ctx.config.serverLabel)] });
        await ctx.observations.ackDigest(pending.key);
      }
    }
    if (channel) {
      let completion = ctx.goals.nextPending();
      while (completion) {
        await channel.send({ embeds: [goalCompletionEmbed(completion, ctx.config.serverLabel)] });
        await ctx.goals.ackPending(completion.goal.id);
        completion = ctx.goals.nextPending();
      }
    }
  };

  const updatePresence = (): void => {
    const snapshot = ctx.snapshots.peek();
    const activity = presenceText(snapshot);
    if (activity === lastPresence) return;
    client.user?.setPresence({
      status: snapshot?.server?.state === "unreachable" ? "dnd" : "online",
      activities: [{ type: ActivityType.Playing, name: activity }],
    });
    lastPresence = activity;
  };

  void observe().catch((error) => console.error("[social] observation failed:", error));
  updatePresence();
  const observeTimer = setInterval(() => {
    void observe().catch((error) => console.error("[social] observation failed:", error));
  }, OBSERVE_INTERVAL_MS);
  const presenceTimer = setInterval(updatePresence, PRESENCE_INTERVAL_MS);
  signal.addEventListener("abort", () => {
    clearInterval(observeTimer);
    clearInterval(presenceTimer);
  }, { once: true });
}

async function sendMilestones(
  channel: TextChannel | NewsChannel,
  milestones: Milestone[],
  ctx: BotContext,
): Promise<void> {
  const label = ctx.config.serverLabel;
  const featured = milestones.slice(0, MAX_MILESTONE_CARDS);
  const cache = assetsFor(ctx.session);
  const cards = await Promise.all(featured.map(async (milestone, index) => {
    try {
      const buffer = await renderMilestoneCard(milestone, cache, label);
      const name = `milestone-${Date.now()}-${index}.jpg`;
      return {
        embed: milestoneEmbed([milestone], label).setImage(`attachment://${name}`),
        file: new AttachmentBuilder(buffer, { name }),
      };
    } catch (error) {
      console.error("[social] milestone card render failed; using text fallback:", error);
      return { embed: milestoneEmbed([milestone], label), file: null };
    }
  }));
  const remaining = milestones.slice(featured.length);
  await channel.send({
    embeds: [
      ...cards.map((card) => card.embed),
      ...(remaining.length > 0 ? [milestoneEmbed(remaining, label)] : []),
    ],
    files: cards.flatMap((card) => card.file ? [card.file] : []),
  });
}

async function authoritativeActivitySeeds(snapshot: WorldSnapshot, ctx: BotContext): Promise<Map<string, number>> {
  const online = snapshot.players.filter((player) => player.online);
  const pairs = await Promise.all(online.map(async (player) => {
    try {
      const sessions = await ctx.session.playerSessions(player.uid);
      const open = sessions.find((session) => session.leaveAt === null);
      const at = open ? Date.parse(open.joinAt) : Number.NaN;
      return Number.isFinite(at) ? [player.uid, at] as const : null;
    } catch {
      return null;
    }
  }));
  const seeds = new Map(pairs.filter((pair): pair is readonly [string, number] => pair !== null));
  if (seeds.size === online.length) return seeds;
  // Older panels or a transient detail failure can still provide an approximate
  // start through bounded events; authoritative session rows always win.
  const fallback = await ctx.session.recentEvents(500).then(activitySeedsFromEvents).catch(() => new Map<string, number>());
  for (const player of online) if (!seeds.has(player.uid) && fallback.has(player.uid)) seeds.set(player.uid, fallback.get(player.uid)!);
  return seeds;
}

function activityEmbed(joins: string[], leaves: string[], onlineCount: number, maxPlayers: number | null): EmbedBuilder {
  const capacity = maxPlayers ? `${onlineCount}/${maxPlayers}` : `${onlineCount}`;
  return new EmbedBuilder()
    .setColor(leaves.length === 0 ? COLOR_PRIMARY : COLOR_NOTICE)
    .setDescription([...joins, ...leaves].join("\n"))
    .setFooter({ text: `${capacity} online now` })
    .setTimestamp(new Date());
}

function healthNoticeEmbed(notice: HealthNotice, label: string): EmbedBuilder {
  const recovered = notice.kind.endsWith("recovered");
  return new EmbedBuilder()
    .setColor(recovered ? COLOR_PRIMARY : COLOR_NOTICE)
    .setTitle(recovered ? `✅ ${label} health recovered` : `⚠️ ${label} health watch`)
    .setDescription(notice.message)
    .setFooter({ text: "Notification only · Palhelm never performs automatic remediation" })
    .setTimestamp();
}

function goalCompletionEmbed(completion: GoalCompletion, label: string): EmbedBuilder {
  const variant = completion.goal.variant === "boss" ? "Boss 👑 "
    : completion.goal.variant === "alpha" ? "Alpha ⭐ "
      : completion.goal.variant === "lucky" ? "Lucky 🍀 " : "";
  return new EmbedBuilder()
    .setColor(COLOR_NOTICE)
    .setTitle(`🎯 Goal completed on ${label}`)
    .setDescription(
      `**${truncate(completion.goal.createdByName, 80)}** was tracking **${variant}${truncate(completion.goal.speciesName, 100)}**.\n` +
      `A new matching Pal was observed at level ${completion.pal.level} · ${truncate(completion.pal.ownerName, 80)}.`,
    )
    .setFooter({ text: `Goal #${completion.goal.id} · observed from the public save snapshot` })
    .setTimestamp(new Date(completion.completedAt));
}

// Discord renders this as "Playing <text>", so every branch leads with "Palworld".
// The second field is server uptime (a real health signal) rather than the world
// day count, which reads as noise at a glance.
function presenceText(snapshot: ReturnType<BotContext["snapshots"]["peek"]>): string {
  const prefix = "Palworld";
  if (!snapshot) return `${prefix} · warming up`;
  if (snapshot.server?.state === "unreachable") return `${prefix} · server offline`;
  const metrics = snapshot.metricsCurrent;
  const online = metrics?.players ?? snapshot.players.filter((player) => player.online).length;
  const capacity = metrics?.maxPlayers ? `${online}/${metrics.maxPlayers} online` : `${online} online`;
  const uptimeSec = metrics?.uptimeSec ?? snapshot.server?.uptimeSec ?? null;
  const uptime = uptimeSec && uptimeSec > 0 ? ` · up ${compactUptime(uptimeSec)}` : "";
  return `${prefix} · ${capacity}${uptime}`;
}

// Two coarse units keep the status glanceable, e.g. "2d 4h", "5h", "12m", "<1m".
function compactUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

function milestoneEmbed(milestones: Milestone[], label: string): EmbedBuilder {
  const shown = milestones.slice(0, MAX_MILESTONE_LINES);
  const lines = shown.map((milestone) => {
    switch (milestone.kind) {
      case "first_species":
        return `📗 **${milestoneText(milestone.playerName)}** added the first observed **${milestoneText(milestone.speciesName)}**`;
      case "first_alpha":
        return `⭐ **${milestoneText(milestone.playerName)}** found their first observed Alpha Pal`;
      case "first_lucky":
        return `🍀 **${milestoneText(milestone.playerName)}** found their first observed Lucky Pal`;
      case "level":
        return `⬆️ **${milestoneText(milestone.playerName)}** reached level ${milestone.value}`;
      case "playtime":
        return `⏱️ **${milestoneText(milestone.playerName)}** passed ${Math.round((milestone.value ?? 0) / 3_600)} hours`;
      case "record":
        return `🏆 **${milestoneText(milestone.playerName)}** passed **${milestoneText(milestone.previousPlayerName)}** for ${milestoneText(milestone.recordLabel)} · ${milestoneText(milestone.recordDetail)} *(observed record)*`;
    }
  });
  if (milestones.length > shown.length) lines.push(`…and ${milestones.length - shown.length} more`);
  return new EmbedBuilder()
    .setColor(COLOR_NOTICE)
    .setTitle(milestones.length === 1 ? `${label} milestone` : `${label} milestones`)
    .setDescription(truncate(lines.join("\n"), 4096))
    .setFooter({ text: "Observed since Palhelm tracking began" })
    .setTimestamp(new Date());
}

function milestoneText(value: string | undefined): string {
  return escapeMarkdown(truncate(value?.trim() ?? "", 100));
}

function digestEmbed(digest: WeeklyDigest, label: string): EmbedBuilder {
  const dayRange = digest.firstDay === null
    ? "—"
    : digest.firstDay === digest.lastDay
      ? `Day ${digest.firstDay}`
      : `Day ${digest.firstDay} → ${digest.lastDay}`;
  const fps = digest.averageFps === null
    ? "No samples"
    : `${digest.averageFps.toFixed(1)} avg · ${digest.lowFps?.toFixed(1) ?? "—"} low`;
  const expected = Math.max(1, Math.floor((Date.parse(digest.endedAt) - Date.parse(digest.startedAt)) / (5 * 60_000)));
  const coverage = Math.min(100, (digest.snapshots / expected) * 100).toFixed(1);
  const embed = new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`📜 ${label} weekly dispatch`)
    .addFields(
      {
        name: "Adventurers",
        value: `${digest.activePlayers.length} played · ${formatDuration(digest.playtimeDeltaSec)} combined`,
      },
      {
        name: "Pals",
        value: `${digest.newPalInstances} new instances · ${digest.newSpecies.length} new species · ${digest.newAlphas} Alpha · ${digest.newLuckies} Lucky`,
      },
      { name: "World", value: `${dayRange} · ${fps}` },
      { name: "Backups", value: `${digest.backups} completed`, inline: true },
      { name: "Tracking coverage", value: `${coverage}%`, inline: true },
    )
    .setTimestamp(new Date(digest.endedAt));
  if (digest.milestones.length > 0) {
    embed.addFields({
      name: "Milestones",
      value: truncate(digest.milestones.slice(0, 12).join("\n"), 1024),
    });
  }
  if (digest.newSpecies.length > 0) {
    embed.addFields({
      name: "New species",
      value: truncate(digest.newSpecies.slice(0, 20).join(", "), 1024),
    });
  }
  embed.setFooter({
    text: `${new Date(digest.startedAt).toLocaleDateString()} – ${new Date(digest.endedAt).toLocaleDateString()}`,
  });
  return embed;
}

function digestDue(now: Date, weekday: number, hour: number): boolean {
  return now.getDay() === weekday && now.getHours() === hour;
}

function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
