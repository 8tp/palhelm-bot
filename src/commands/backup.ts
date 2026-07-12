import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import {
  COLOR_SUCCESS,
  errorEmbed,
  formatBytes,
  truncate,
} from "../discord/embeds.js";
import { ApiError } from "../palhelm/integration.js";

export const backupCommand: Command = {
  helpCategory: "admin",
  data: new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Trigger a world backup now (admin)"),
  adminOnly: true,
  async execute(interaction, ctx) {
    await interaction.deferReply();

    try {
      const backup = await ctx.session.createBackup();
      const embed = new EmbedBuilder()
        .setColor(COLOR_SUCCESS)
        .setTitle("Backup created")
        .addFields(
          { name: "File", value: truncate(backup.file, 1024) },
          { name: "Size", value: formatBytes(backup.sizeBytes), inline: true },
          ...(backup.worldDay !== undefined
            ? [{ name: "World day", value: String(backup.worldDay), inline: true }]
            : []),
          {
            name: "Requested by",
            value: `<@${interaction.user.id}>`,
            inline: true,
          },
        )
        .setTimestamp(new Date());

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await interaction.editReply({
          embeds: [
            errorEmbed("Another backup operation is in progress. Please try again shortly."),
          ],
        });
        return;
      }
      throw err;
    }
  },
};
