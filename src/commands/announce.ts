import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { COLOR_SUCCESS } from "../discord/embeds.js";

export const announceCommand: Command = {
  helpCategory: "admin",
  data: new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Broadcast an in-game announcement (admin)")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("The message to broadcast in-game")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(200),
    ),
  adminOnly: true,
  async execute(interaction, ctx) {
    await interaction.deferReply();

    const message = interaction.options.getString("message", true);
    await ctx.session.announce(message);

    const quoted = message.replaceAll("\n", "\n> ");
    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setTitle("Announcement sent")
      .setDescription(`> ${quoted}`)
      .addFields({
        name: "Sent by",
        value: `<@${interaction.user.id}>`,
      })
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
  },
};
