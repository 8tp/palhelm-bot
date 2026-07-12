import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { isBossVariant, palOwnerLabel, palVariantTags } from "../pals/presentation.js";

export const rareCommand: Command = {
  helpCategory: "pals",
  data: new SlashCommandBuilder()
    .setName("rare")
    .setDescription("Show currently observed Boss, Alpha, and Lucky Pals")
    .addStringOption((option) => option
      .setName("player")
      .setDescription("Optional exact player name")
      .setAutocomplete(true)),

  async autocomplete(interaction, ctx) {
    try {
      const focused = interaction.options.getFocused().toLowerCase();
      const snapshot = await ctx.snapshots.get();
      await interaction.respond(snapshot.players
        .filter((player) => player.name.toLowerCase().includes(focused))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 25)
        .map((player) => ({ name: player.name.slice(0, 100), value: player.uid })));
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const snapshot = await ctx.snapshots.get();
    const query = interaction.options.getString("player");
    const player = query
      ? snapshot.players.find((item) => item.uid === query) ?? snapshot.players.find((item) => item.name.toLowerCase() === query.toLowerCase())
      : null;
    if (query && !player) {
      await interaction.editReply({ embeds: [baseEmbed("Player not found").setDescription("No current player matched that name.")] });
      return;
    }
    const rare = snapshot.pals
      .filter((pal) => (!player || pal.ownerUid === player.uid) && (pal.isAlpha || pal.isLucky || isBossVariant(pal)))
      .sort((a, b) => Number(isBossVariant(b)) - Number(isBossVariant(a)) || b.level - a.level || a.displayName.localeCompare(b.displayName));
    const lines = rare.slice(0, 30).map((pal) => {
      const owner = palOwnerLabel(pal, snapshot.players);
      return `Lv ${pal.level} **${truncate(pal.displayName, 80)}**${palVariantTags(pal)} · ${truncate(owner, 60)}`;
    });
    if (rare.length > lines.length) lines.push(`…and ${rare.length - lines.length} more`);
    const counts = `${rare.filter(isBossVariant).length} Boss · ${rare.filter((pal) => pal.isAlpha && !isBossVariant(pal)).length} Alpha · ${rare.filter((pal) => pal.isLucky).length} Lucky`;
    await interaction.editReply({ embeds: [baseEmbed(player ? `✨ ${player.name}'s Rare Pals` : `✨ ${ctx.config.serverLabel} rare gallery`)
      .setDescription(lines.length > 0 ? `**${counts}**\n\n${truncate(lines.join("\n"), 3900)}` : "No matching rare Pals are currently observed.")
      .setFooter({ text: "Current save snapshot · 👑 Boss · ⭐ Alpha · 🍀 Lucky" })] });
  },
};
