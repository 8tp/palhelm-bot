import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import {
  assetsFor,
  boxPageCount,
  FORMAT_DRIFT_WARNING,
  palLine,
  renderPalGrid,
} from "../discord/palrender.js";
import { ApiError } from "../palhelm/integration.js";
import type { PlayerDetail } from "../types.js";

const MAX_ICONS = 30;

export const palsCommand: Command = {
  helpCategory: "pals",
  data: new SlashCommandBuilder()
    .setName("pals")
    .setDescription("Show a player's pals with icons")
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
      await interaction.respond([]);
      return;
    }
    const matches = players
      .filter((p) =>
        focused ? p.name.toLowerCase().startsWith(focused) : true,
      )
      .slice(0, 25)
      .map((p) => ({ name: p.name.slice(0, 100), value: p.uid }));
    await interaction.respond(matches);
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const query = interaction.options.getString("player", true);

    let detail: PlayerDetail | null = null;
    let formatDrift = false;

    // Autocomplete supplies a uid; hand-typed names 404 → exact-name fallback.
    try {
      const env = await ctx.integration.player(query);
      detail = env.data;
      formatDrift = env.formatDrift === true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      const roster = await ctx.integration.players();
      if (roster.formatDrift) formatDrift = true;
      const match = roster.data.find(
        (p) => p.name.toLowerCase() === query.toLowerCase(),
      );
      if (match) {
        try {
          const env = await ctx.integration.player(match.uid);
          detail = env.data;
          formatDrift = env.formatDrift === true || formatDrift;
        } catch (err2) {
          if (!(err2 instanceof ApiError) || err2.status !== 404) throw err2;
        }
      }
    }

    if (!detail) {
      await interaction.editReply({
        embeds: [
          baseEmbed("Player not found").setDescription(
            formatDrift && !ctx.config.suppressDriftNotices
              ? FORMAT_DRIFT_WARNING
              : `No player matching **${query}** — they may never have joined, or the save hasn't been parsed yet.`,
          ),
        ],
      });
      return;
    }

    const hasPartyData = detail.pals.some((pal) => pal.inParty !== undefined);
    // Older panels retain the original top-30-by-level behavior unchanged.
    const sorted = hasPartyData
      ? detail.pals
          .filter((pal) => pal.inParty)
          .sort((a, b) => (a.partySlot ?? Number.MAX_SAFE_INTEGER) - (b.partySlot ?? Number.MAX_SAFE_INTEGER))
      : [...detail.pals].sort((a, b) => b.level - a.level);
    const shown = sorted.slice(0, hasPartyData ? 5 : MAX_ICONS);
    const overflow = sorted.length - shown.length;

    const listLines = shown.map(palLine);
    if (overflow > 0) listLines.push(`…and ${overflow} more`);
    // Keep the list field under Discord's 1024 limit.
    let listText = listLines.join("\n") || "_No pals_";
    while (listText.length > 1024 && listLines.length > 1) {
      listLines.pop();
      const dropped = sorted.length - listLines.length;
      listText =
        listLines.join("\n") +
        (dropped > 0 ? `\n…and ${dropped} more` : "");
    }
    listText = truncate(listText, 1024);

    const embed = baseEmbed(hasPartyData ? `${detail.name}'s party` : `${detail.name}'s pals`)
      .addFields(
        { name: "Level", value: `${detail.level}`, inline: true },
        { name: "Pals", value: `${detail.pals.length}`, inline: true },
        {
          name: "Guild",
          value: truncate(detail.guildName ?? "—", 1024),
          inline: true,
        },
      );

    if (hasPartyData) {
      const storedCount = detail.pals.filter((pal) => pal.boxPage !== null && pal.boxPage !== undefined).length;
      const pages = boxPageCount(detail.pals);
      const storageDescription = `${storedCount} stored pals across ${pages} box page${pages === 1 ? "" : "s"}. Use /box player page to browse the box.`;
      embed.setDescription(
        formatDrift && !ctx.config.suppressDriftNotices
          ? `${FORMAT_DRIFT_WARNING}\n\n${storageDescription}`
          : storageDescription,
      );
    }

    if (shown.length === 0) {
      // Drift + empty: warn only — never a cheerful "no pals" empty state.
      if (!hasPartyData) {
        embed.setDescription(
          formatDrift && !ctx.config.suppressDriftNotices
            ? FORMAT_DRIFT_WARNING
            : "This player has no pals in the current save.",
        );
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (formatDrift && !ctx.config.suppressDriftNotices && !hasPartyData) {
      embed.setDescription(FORMAT_DRIFT_WARNING);
    }

    embed.addFields({ name: hasPartyData ? "Party" : "Roster", value: listText });

    const assets = assetsFor(ctx.session);
    const iconAssets = await Promise.all(
      shown.map((p) => assets.palIcon(p.characterId)),
    );
    const anyIcon = iconAssets.some((a) => a !== null);

    if (!anyIcon) {
      embed.setFooter({
        text: "Pal icons have not been fetched on the panel (scripts/fetch-pal-icons.sh).",
      });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const iconBuffers = iconAssets.map((a) => (a ? a.buffer : null));
    const png = await renderPalGrid(shown, iconBuffers, {
      cols: hasPartyData ? shown.length : 6,
      rows: hasPartyData ? 1 : undefined,
    });
    const file = new AttachmentBuilder(png, { name: "pals.png" });
    embed.setImage("attachment://pals.png");
    if (overflow > 0 && !hasPartyData) {
      embed.setFooter({ text: `Showing top ${shown.length} of ${detail.pals.length} pals by level` });
    }

    await interaction.editReply({ embeds: [embed], files: [file] });
  },
};
