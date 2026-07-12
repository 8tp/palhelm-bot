import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";

const MAX_LINES = 30;

/** Shown when the panel reports save format drift — never confuse with "empty world". */
const FORMAT_DRIFT_WARNING =
  "⚠️ Palhelm can't fully parse this Palworld save version yet — data may be incomplete or missing.";

export const playersCommand: Command = {
  helpCategory: "players",
  data: new SlashCommandBuilder()
    .setName("players")
    .setDescription("List players currently online"),
  async execute(interaction, ctx) {
    await interaction.deferReply();

    const {
      data: players,
      lastParseAt,
      formatDrift,
    } = await ctx.integration.players({
      online: true,
    });

    const embed = baseEmbed(`${players.length} players online`);

    if (players.length === 0) {
      // Drift + empty: warn only — never a cheerful "nobody online" empty state.
      embed.setDescription(
          formatDrift && !ctx.config.suppressDriftNotices
          ? FORMAT_DRIFT_WARNING
          : "Nobody online right now — the world is quiet. 🌙",
      );
    } else {
      const shown = players.slice(0, MAX_LINES);
      const lines = shown.map((p) => {
        const guild = p.guildName ? ` · ${truncate(p.guildName, 40)}` : "";
        return `**${truncate(p.name, 60)}** — Lv ${p.level}${guild}`;
      });
      if (players.length > MAX_LINES) {
        lines.push(`…and ${players.length - MAX_LINES} more`);
      }
      const body = lines.join("\n");
      embed.setDescription(
        formatDrift && !ctx.config.suppressDriftNotices ? `${FORMAT_DRIFT_WARNING}\n\n${body}` : body,
      );
    }

    if (lastParseAt) {
      // Footers don't render Discord relative markup, so a plain date reads best.
      embed.setFooter({
        text: `Save data parsed ${new Date(lastParseAt).toUTCString()}`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
