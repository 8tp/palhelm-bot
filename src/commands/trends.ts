import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, discordRelative, formatDuration, truncate } from "../discord/embeds.js";
import { barChartPng } from "../discord/charts.js";
import type { PlayerTrend } from "../history/tracker.js";

const WINDOWS: Record<string, { label: string; ms: number }> = {
  "24h": { label: "last 24 hours", ms: 24 * 3_600_000 },
  "7d": { label: "last 7 days", ms: 7 * 86_400_000 },
  "30d": { label: "last 30 days", ms: 30 * 86_400_000 },
};

const TOP = 5;

function topBy(players: PlayerTrend[], value: (trend: PlayerTrend) => number): PlayerTrend[] {
  return players
    .filter((trend) => value(trend) > 0)
    .sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.uid.localeCompare(b.uid))
    .slice(0, TOP);
}

export const trendsCommand: Command = {
  helpCategory: "players",
  data: new SlashCommandBuilder()
    .setName("trends")
    .setDescription("Show who has grown the most on the server over a time window")
    .addStringOption((option) =>
      option
        .setName("window")
        .setDescription("Time window (defaults to the last 7 days)")
        .addChoices(
          { name: "Last 24 hours", value: "24h" },
          { name: "Last 7 days", value: "7d" },
          { name: "Last 30 days", value: "30d" },
        ),
    ),

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const key = interaction.options.getString("window") ?? "7d";
    const window = WINDOWS[key] ?? WINDOWS["7d"]!;
    const snapshot = await ctx.snapshots.get();
    const report = ctx.observations.trends(window.ms, snapshot);

    const embed = baseEmbed(`📈 ${ctx.config.serverLabel} Trends — ${window.label}`);
    if (!report || report.players.length === 0) {
      embed.setDescription(
        "Not enough tracked history yet. Trends need a little time to accumulate after the bot starts watching the server.",
      );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const levels = topBy(report.players, (trend) => trend.levelGain);
    const playtime = topBy(report.players, (trend) => trend.playtimeGainSec);
    const pals = topBy(report.players, (trend) => trend.palGain);

    if (levels.length === 0 && playtime.length === 0 && pals.length === 0) {
      embed.setDescription(`No measurable movement in the ${window.label}. It's been quiet on ${ctx.config.serverLabel}.`);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const coverage = report.fullWindow
      ? `Measured over the ${window.label}.`
      : `⚠️ History only reaches back to ${discordRelative(report.windowStart)}, so this is a partial window.`;
    embed.setDescription(coverage);

    if (levels.length > 0) {
      embed.addFields({
        name: "⬆️ Levels gained",
        value: levels.map((trend) => `**${truncate(trend.name, 60)}** +${trend.levelGain} → Lv ${trend.currentLevel}`).join("\n"),
      });
    }
    if (playtime.length > 0) {
      embed.addFields({
        name: "⏱️ Time played",
        value: playtime.map((trend) => `**${truncate(trend.name, 60)}** +${formatDuration(trend.playtimeGainSec)}`).join("\n"),
      });
    }
    if (pals.length > 0) {
      embed.addFields({
        name: "🐾 Pals added",
        value: pals.map((trend) => `**${truncate(trend.name, 60)}** +${trend.palGain}`).join("\n"),
      });
    }
    embed.setFooter({ text: `Since ${new Date(report.windowStart).toUTCString()} · current-roster figures` });

    // Headline chart: level gains when there are any, else time played.
    const chartFrom = levels.length > 0
      ? { title: `Levels gained · ${window.label}`, items: levels.map((t) => ({ label: t.name, value: t.levelGain, display: `+${t.levelGain}` })) }
      : playtime.length > 0
        ? { title: `Time played · ${window.label}`, items: playtime.map((t) => ({ label: t.name, value: t.playtimeGainSec, display: `+${formatDuration(t.playtimeGainSec)}` })) }
        : null;
    const files: AttachmentBuilder[] = [];
    if (chartFrom) {
      embed.setImage("attachment://trends.png");
      files.push(new AttachmentBuilder(await barChartPng(chartFrom.title, chartFrom.items), { name: "trends.png" }));
    }

    await interaction.editReply({ embeds: [embed], files });
  },
};
