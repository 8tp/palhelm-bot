import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, formatDuration } from "../discord/embeds.js";

export const metricsCommand: Command = {
  helpCategory: "server",
  data: new SlashCommandBuilder()
    .setName("metrics")
    .setDescription("Current server performance metrics"),
  async execute(interaction, ctx) {
    await interaction.deferReply();

    const { data: m } = await ctx.integration.metricsCurrent();

    const embed = baseEmbed("Server metrics").addFields(
      { name: "FPS", value: `${Math.round(m.fps)}`, inline: true },
      { name: "FPS (avg)", value: `${Math.round(m.fpsAvg)}`, inline: true },
      {
        name: "Frame time",
        value: `${m.frameTimeMs.toFixed(1)} ms`,
        inline: true,
      },
      {
        name: "Players",
        value: `${m.players}/${m.maxPlayers}`,
        inline: true,
      },
      { name: "In-game day", value: `${m.day}`, inline: true },
      { name: "Uptime", value: formatDuration(m.uptimeSec), inline: true },
      { name: "Base camps", value: `${m.baseCamps}`, inline: true },
    );

    await interaction.editReply({ embeds: [embed] });
  },
};
