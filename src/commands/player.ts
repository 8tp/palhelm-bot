import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { palVariantTags } from "../pals/presentation.js";
import { ApiError } from "../palhelm/integration.js";
import type { PlayerDetail } from "../types.js";
import { baseEmbed, discordRelative, formatDuration } from "../discord/embeds.js";

const TOP_PALS = 10;

export const playerCommand: Command = {
  helpCategory: "players",
  data: new SlashCommandBuilder()
    .setName("player")
    .setDescription("Look up a player and their pals")
    .addStringOption((o) =>
      o
        .setName("player")
        .setDescription("Player name")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction, ctx) {
    const focused = interaction.options.getFocused().toLowerCase();
    let players;
    try {
      players = (await ctx.integration.players()).data;
    } catch {
      // Autocomplete must never throw a hard error at the user; empty is fine.
      await interaction.respond([]);
      return;
    }
    const matches = players
      .filter((p) => p.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((p) => ({ name: p.name.slice(0, 100), value: p.uid }));
    await interaction.respond(matches);
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const query = interaction.options.getString("player", true);

    let detail: PlayerDetail | null = null;

    // Autocomplete supplies a uid; a hand-typed name won't resolve, so 404 →
    // fall back to a case-insensitive exact-name lookup over the roster.
    try {
      detail = (await ctx.integration.player(query)).data;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      const roster = (await ctx.integration.players()).data;
      const match = roster.find(
        (p) => p.name.toLowerCase() === query.toLowerCase(),
      );
      if (match) {
        try {
          detail = (await ctx.integration.player(match.uid)).data;
        } catch (err2) {
          if (!(err2 instanceof ApiError) || err2.status !== 404) throw err2;
        }
      }
    }

    if (!detail) {
      await interaction.editReply({
        embeds: [
          baseEmbed("Player not found").setDescription(
            `No player matching **${query}** — they may never have joined, or the save hasn't been parsed yet.`,
          ),
        ],
      });
      return;
    }

    const embed = baseEmbed(detail.name);
    const status = detail.online
      ? "🟢 Online"
      : `⚫ Offline · last seen ${discordRelative(detail.lastSeenAt)}`;

    embed.addFields(
      { name: "Status", value: status, inline: true },
      { name: "Level", value: `${detail.level}`, inline: true },
      { name: "Guild", value: detail.guildName ?? "—", inline: true },
      {
        name: "Playtime",
        value: formatDuration(detail.playtimeSec),
        inline: true,
      },
      {
        name: "First seen",
        value: discordRelative(detail.firstSeenAt),
        inline: true,
      },
      { name: "Pals", value: `${detail.pals.length}`, inline: true },
    );

    if (detail.captureTotal !== undefined || detail.uniquePalsCaptured !== undefined || detail.paldeckUnlocked !== undefined) {
      embed.addFields({
        name: "Lifetime progress",
        value: [
          detail.captureTotal === undefined ? null : `Captures: **${detail.captureTotal.toLocaleString()}**`,
          detail.uniquePalsCaptured === undefined ? null : `Species caught: **${detail.uniquePalsCaptured}**`,
          detail.paldeckUnlocked === undefined ? null : `Paldeck unlocked: **${detail.paldeckUnlocked}**`,
        ].filter(Boolean).join(" · "),
      });
    }

    if (detail.pals.length > 0) {
      const top = [...detail.pals]
        .sort((a, b) => b.level - a.level)
        .slice(0, TOP_PALS);
      const lines = top.map((p) => {
        const tags = palVariantTags(p);
        return `Lv ${String(p.level).padStart(2, "0")} ${p.displayName}${tags}`;
      });
      if (detail.pals.length > TOP_PALS) {
        lines.push(`…and ${detail.pals.length - TOP_PALS} more`);
      }
      embed.addFields({ name: "Top pals", value: lines.join("\n") });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
