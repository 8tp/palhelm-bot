import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import {
  baseEmbed,
  discordRelative,
  formatBytes,
} from "../discord/embeds.js";

export const backupsCommand: Command = {
  helpCategory: "admin",
  data: new SlashCommandBuilder()
    .setName("backups")
    .setDescription("List recent world backups (admin)"),
  adminOnly: true,
  async execute(interaction, ctx) {
    await interaction.deferReply();

    const [backups, schedule] = await Promise.all([
      ctx.session.listBackups(),
      ctx.session.backupSchedule(),
    ]);
    const lines = backups.slice(0, 10).map((backup) => {
      const worldDay =
        backup.worldDay !== undefined ? ` · day ${backup.worldDay}` : "";
      return `${discordRelative(backup.createdAt)} · ${backup.trigger} · ${formatBytes(backup.sizeBytes)}${worldDay}`;
    });
    if (backups.length === 0) lines.push("No backups have been created yet.");
    if (backups.length > 10) {
      lines.push(`…and ${backups.length - 10} more (${backups.length} total)`);
    }

    const scheduleLines = [
      schedule.enabled ? "Enabled" : "Disabled",
      `Every ${schedule.everyMinutes} minutes`,
      `Keep for ${schedule.keepDays} days`,
    ];
    if (schedule.nextRunAt !== null) {
      scheduleLines.push(`Next run ${discordRelative(schedule.nextRunAt)}`);
    }

    const embed = baseEmbed("World backups")
      .setDescription(lines.join("\n"))
      .addFields({ name: "Schedule", value: scheduleLines.join("\n") });

    await interaction.editReply({ embeds: [embed] });
  },
};
