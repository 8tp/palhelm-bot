import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import {
  COLOR_ERROR,
  COLOR_PRIMARY,
  discordRelative,
  formatDuration,
} from "../discord/embeds.js";

// STATE display: the Integration /server endpoint is served from the poller's
// last-successful snapshot and reports "unreachable" (never a 5xx) when it has
// none — surface that clearly rather than pretending the box is fine.
export const statusCommand: Command = {
  helpCategory: "server",
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Server status and health at a glance"),
  async execute(interaction, ctx) {
    await interaction.deferReply();

    // Metrics can fail independently of the cached server snapshot.
    const [serverR, metricsR] = await Promise.allSettled([
      ctx.integration.server(),
      ctx.integration.metricsCurrent(),
    ]);

    if (serverR.status === "rejected") throw serverR.reason;
    const server = serverR.value.data;
    const metrics =
      metricsR.status === "fulfilled" ? metricsR.value.data : null;

    const unreachable = server.state === "unreachable";
    const embed = new EmbedBuilder()
      .setColor(unreachable ? COLOR_ERROR : COLOR_PRIMARY)
      .setTitle(server.name || "Palworld server")
      .setTimestamp(new Date());

    if (server.description) embed.setDescription(server.description);

    const stateText = unreachable
      ? "🔴 unreachable — the panel has no live snapshot yet"
      : `🟢 ${server.state}`;

    embed.addFields(
      { name: "State", value: stateText, inline: true },
      {
        name: "Version",
        value: server.version || "—",
        inline: true,
      },
      {
        name: "Uptime",
        value: server.uptimeSec ? formatDuration(server.uptimeSec) : "—",
        inline: true,
      },
    );

    // Newer panels include save-parse health; older panels omit the object.
    if (server.save) {
      let saveText: string;
      if (server.save.state === "ok") {
        saveText = server.save.lastParseAt
          ? `✅ parsed ${discordRelative(server.save.lastParseAt)}`
          : "✅ parsed";
      } else if (server.save.state === "drift") {
        saveText =
          "⚠️ format drift — panel can't fully read this save version";
      } else {
        saveText = "no parse yet";
      }
      embed.addFields({ name: "Save", value: saveText, inline: true });
    }

    if (metrics) {
      embed.addFields(
        {
          name: "Players",
          value: `${metrics.players}/${metrics.maxPlayers}`,
          inline: true,
        },
        { name: "In-game day", value: `${metrics.day}`, inline: true },
        {
          name: "FPS",
          value: `${Math.round(metrics.fps)} (avg ${Math.round(metrics.fpsAvg)})`,
          inline: true,
        },
      );
    } else {
      embed.addFields({
        name: "Metrics",
        value: "Live metrics are unavailable right now.",
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
