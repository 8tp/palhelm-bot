import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, discordRelative, formatDuration } from "../discord/embeds.js";
import type { WorldSnapshot } from "../snapshots/service.js";
import type { HealthHistorySummary } from "../history/tracker.js";

const FRESH_SNAPSHOT_MS = 10 * 60_000;

export const diagnosticsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("diagnostics")
    .setDescription("Show safe bot cache and automation status (admin)"),
  helpCategory: "admin",
  adminOnly: true,

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // This command is intentionally side-effect free. In particular, opening
    // diagnostics must not spend Integration API quota on a snapshot refresh.
    const snapshot = ctx.snapshots.peek();
    const knowledge = ctx.knowledge.status();
    const trackingStartedAt = ctx.observations.trackingStartedAt();
    const lastBackupAt = ctx.observations.lastBackupAt();
    const pendingMilestones = ctx.observations.nextMilestoneBatch();
    const pendingDigest = ctx.observations.nextPendingDigest();
    const healthHistory = ctx.observations.healthHistorySummary();

    const embed = baseEmbed("🩺 Palhelm Diagnostics")
      .setDescription("Read-only status from existing bot caches and configuration. No live refresh was requested.")
      .addFields(
        { name: "Snapshot cache", value: snapshotSummary(snapshot) },
        {
          name: "Palworld knowledge",
          value: knowledge.ready
            ? [
                `✅ Ready · ${knowledge.palCount} pals · ${knowledge.breedingCombinationCount.toLocaleString("en-US")} breeding combinations`,
                knowledge.metadata
                  ? `Schema v${knowledge.metadata.schemaVersion} · generated ${discordRelative(knowledge.metadata.generatedAt)} · ${knowledge.metadata.sources.length} pinned sources`
                  : null,
              ].filter(Boolean).join("\n")
            : "⚠️ Not ready — knowledge commands will degrade safely",
        },
        {
          name: "History coverage",
          value: [
            trackingStartedAt
              ? `Tracking since ${discordRelative(trackingStartedAt)} (${formatAge(trackingStartedAt)})`
              : "No tracking baseline yet",
            lastBackupAt ? `Last observed backup ${discordRelative(lastBackupAt)}` : "No completed backup observed yet",
            healthHistory ? healthHistoryLine(healthHistory) : "Health history is still building",
            `Pending delivery: ${pendingMilestones ? "milestones" : "none"}${pendingDigest ? " · weekly digest" : ""}`,
          ].join("\n"),
        },
        {
          name: "AI & search",
          value: [
            ctx.openRouter
              ? `✅ AI enabled · ${ctx.config.openRouterModel} · ${ctx.config.aiDailyRequestLimit}/day · ${ctx.config.aiCooldownSec}s cooldown`
              : "⬜ AI disabled (no provider key configured)",
            ctx.webSearch ? "✅ Palworld web search enabled" : "⬜ Palworld web search disabled",
          ].join("\n"),
        },
        {
          name: "Automations",
          value: [
            `Milestones: ${enabled(ctx.config.milestonesEnabled)} · ${ctx.config.milestonesChannelId ? "dedicated channel" : "notify channel"}`,
            `Weekly digest: ${enabled(ctx.config.digestEnabled)} · ${weekday(ctx.config.digestWeekday)} at ${String(ctx.config.digestHour).padStart(2, "0")}:00 local`,
            `Health alerts: ${enabled(ctx.config.healthAlertsEnabled)}`,
            `Activity feed: ${ctx.config.activityChannelId ? "✅ dedicated channel" : "⬜ not configured"}`,
          ].join("\n"),
        },
      )
      .setFooter({ text: "Secrets, URLs, credentials, role IDs, and channel IDs are intentionally omitted." });

    await interaction.editReply({ embeds: [embed] });
  },
};

function snapshotSummary(snapshot: WorldSnapshot | null): string {
  if (!snapshot) return "⚠️ Not ready — the first background snapshot has not completed";
  const ageMs = Date.now() - Date.parse(snapshot.capturedAt);
  const freshness = Number.isFinite(ageMs) && ageMs <= FRESH_SNAPSHOT_MS ? "✅ Fresh" : "⚠️ Stale";
  const population = `${snapshot.players.filter((player) => player.online).length}/${snapshot.metricsCurrent?.maxPlayers ?? "?"} online`;
  return [
    `${freshness} · captured ${discordRelative(snapshot.capturedAt)} · ${population}`,
    `${snapshot.players.length} players · ${snapshot.pals.length} pals · ${snapshot.guilds.length} guilds`,
    `Telemetry: ${snapshot.metricsCurrent ? "available" : "unavailable"} · server status: ${snapshot.server ? "available" : "unavailable"}`,
  ].join("\n");
}

function formatAge(at: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(at)) / 1_000);
  return `${formatDuration(seconds)} of history`;
}

function enabled(value: boolean): string {
  return value ? "✅ enabled" : "⬜ disabled";
}

function healthHistoryLine(summary: HealthHistorySummary): string {
  const coverageSec = Math.max(0, (Date.parse(summary.endedAt) - Date.parse(summary.startedAt)) / 1_000);
  const coverage = `${summary.sampleCount} samples over ${formatDuration(coverageSec)}`;
  const fps = summary.averageFps === null || summary.lowFps === null
    ? "FPS unavailable"
    : `FPS ${summary.averageFps.toFixed(1)} avg · ${summary.lowFps.toFixed(1)} low`;
  return `Health: ${coverage} · ${fps}`;
}

function weekday(day: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ?? "Unknown day";
}
