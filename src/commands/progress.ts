import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, formatDuration } from "../discord/embeds.js";

export const progressCommand: Command = {
  helpCategory: "players",
  data: new SlashCommandBuilder()
    .setName("progress")
    .setDescription("Show a player's lifetime Pal capture progress")
    .addStringOption((option) => option
      .setName("player")
      .setDescription("Player name")
      .setRequired(true)
      .setAutocomplete(true)),

  async autocomplete(interaction, ctx) {
    const focused = interaction.options.getFocused().toLowerCase();
    try {
      const players = (await ctx.integration.players()).data;
      await interaction.respond(players
        .filter((player) => player.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((player) => ({ name: player.name.slice(0, 100), value: player.uid })));
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const query = interaction.options.getString("player", true);
    const players = (await ctx.integration.players()).data;
    const player = players.find((item) => item.uid === query)
      ?? players.find((item) => item.name.toLowerCase() === query.toLowerCase());

    if (!player) {
      await interaction.editReply({ embeds: [baseEmbed("Player not found")
        .setDescription(`No player matching **${query}**.`)] });
      return;
    }

    const available = player.captureTotal !== undefined
      || player.uniquePalsCaptured !== undefined
      || player.paldeckUnlocked !== undefined;
    const embed = baseEmbed(`${player.name} · progression`)
      .setDescription(available
        ? "Lifetime counters decoded directly from this character's player save."
        : "Lifetime capture counters are unavailable until the updated panel has parsed this player's save.")
      .addFields(
        { name: "Level", value: String(player.level), inline: true },
        { name: "Playtime", value: formatDuration(player.playtimeSec), inline: true },
        { name: "Lifetime captures", value: player.captureTotal?.toLocaleString() ?? "Unavailable", inline: true },
        { name: "Species caught", value: player.uniquePalsCaptured?.toLocaleString() ?? "Unavailable", inline: true },
        { name: "Paldeck unlocked", value: player.paldeckUnlocked?.toLocaleString() ?? "Unavailable", inline: true },
      )
      .setFooter({ text: "Paldeck unlocked means seen/unlocked; it is not the same as species caught." });
    await interaction.editReply({ embeds: [embed] });
  },
};
