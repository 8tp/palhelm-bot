import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";

const MAX_GUILDS = 15;
const MAX_MEMBERS = 5;

/** Shown when the panel reports save format drift — never confuse with "empty world". */
const FORMAT_DRIFT_WARNING =
  "⚠️ Palhelm can't fully parse this Palworld save version yet — data may be incomplete or missing.";

export const guildsCommand: Command = {
  helpCategory: "players",
  data: new SlashCommandBuilder()
    .setName("guilds")
    .setDescription("List guilds, members, and bases"),
  async execute(interaction, ctx) {
    await interaction.deferReply();

    const { data: guilds, formatDrift } = await ctx.integration.guilds();
    const totalBases = guilds.reduce((n, g) => n + g.bases.length, 0);

    const embed = baseEmbed("Guilds");

    if (guilds.length === 0) {
      // Drift + empty: warn only — never a cheerful "no guilds" empty state.
      embed.setDescription(
        formatDrift && !ctx.config.suppressDriftNotices
          ? FORMAT_DRIFT_WARNING
          : "No guilds found in the current save.",
      );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const summary = `${guilds.length} guild${guilds.length === 1 ? "" : "s"} · ${totalBases} base${totalBases === 1 ? "" : "s"} total`;
    embed.setDescription(
      formatDrift && !ctx.config.suppressDriftNotices
        ? `${FORMAT_DRIFT_WARNING}\n\n${summary}`
        : summary,
    );

    for (const g of guilds.slice(0, MAX_GUILDS)) {
      const memberNames = g.members
        .slice(0, MAX_MEMBERS)
        .map((m) => m.name)
        .join(", ");
      const extraMembers = g.memberCount - Math.min(g.members.length, MAX_MEMBERS);
      const membersLine = memberNames
        ? `${memberNames}${extraMembers > 0 ? `, +${extraMembers} more` : ""}`
        : "—";
      const value = `${membersLine}\n${g.bases.length} base${g.bases.length === 1 ? "" : "s"}`;
      embed.addFields({
        name: truncate(`${g.name} · ${g.memberCount} members`, 256),
        value: truncate(value, 1024),
      });
    }

    if (guilds.length > MAX_GUILDS) {
      embed.addFields({
        name: "​",
        value: `…and ${guilds.length - MAX_GUILDS} more guilds`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
