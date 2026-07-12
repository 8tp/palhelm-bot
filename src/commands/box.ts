import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  SlashCommandBuilder,
} from "discord.js";
import type { InteractionEditReplyOptions } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import {
  assetsFor,
  BOX_COLS,
  BOX_ROWS,
  boxPageCount,
  FORMAT_DRIFT_WARNING,
  palLine,
  renderPalGrid,
} from "../discord/palrender.js";
import { ApiError } from "../palhelm/integration.js";
import type { Pal, PlayerDetail } from "../types.js";

const COLLECTOR_MS = 180_000;

function cappedPalList(pals: readonly Pal[]): string {
  const lines = pals.map(palLine);
  for (let included = lines.length; included >= 0; included--) {
    const omitted = lines.length - included;
    const candidate = [
      ...lines.slice(0, included),
      ...(omitted > 0 ? [`…and ${omitted} more`] : []),
    ].join("\n");
    if (candidate.length <= 1024) return candidate || "_No pals in this page_";
  }
  return truncate(lines[0] ?? "_No pals in this page_", 1024);
}

function navRow(page: number, totalPages: number, disableAll = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("box_prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(disableAll || page <= 1),
    new ButtonBuilder().setCustomId("box_page").setLabel(`Page ${page}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("box_next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(disableAll || page >= totalPages),
  );
}

export const boxCommand: Command = {
  helpCategory: "pals",
  data: new SlashCommandBuilder()
    .setName("box")
    .setDescription("Browse a player's pal box, flipping pages with buttons")
    .addStringOption((option) =>
      option
        .setName("player")
        .setDescription("Player name")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("page")
        .setDescription("Box page to open first (starts at 1)")
        .setMinValue(1),
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
      .filter((player) => (focused ? player.name.toLowerCase().startsWith(focused) : true))
      .slice(0, 25)
      .map((player) => ({ name: player.name.slice(0, 100), value: player.uid }));
    await interaction.respond(matches);
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const query = interaction.options.getString("player", true);
    const requestedPage = interaction.options.getInteger("page") ?? 1;
    const showDrift = () => !ctx.config.suppressDriftNotices;

    let detail: PlayerDetail | null = null;
    let formatDrift = false;

    // Autocomplete supplies a uid; hand-typed names 404 → exact-name fallback.
    try {
      const envelope = await ctx.integration.player(query);
      detail = envelope.data;
      formatDrift = envelope.formatDrift === true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      const roster = await ctx.integration.players();
      if (roster.formatDrift) formatDrift = true;
      const match = roster.data.find((player) => player.name.toLowerCase() === query.toLowerCase());
      if (match) {
        try {
          const envelope = await ctx.integration.player(match.uid);
          detail = envelope.data;
          formatDrift = envelope.formatDrift === true || formatDrift;
        } catch (err2) {
          if (!(err2 instanceof ApiError) || err2.status !== 404) throw err2;
        }
      }
    }

    if (!detail) {
      await interaction.editReply({
        embeds: [
          baseEmbed("Player not found").setDescription(
            formatDrift && showDrift()
              ? FORMAT_DRIFT_WARNING
              : `No player matching **${query}** — they may never have joined, or the save hasn't been parsed yet.`,
          ),
        ],
      });
      return;
    }

    const player = detail;
    const hasBoxData = player.pals.some((pal) => pal.boxPage !== undefined);
    if (!hasBoxData) {
      const message = "The panel needs an update to expose pal box data before /box can be used.";
      await interaction.editReply({
        embeds: [baseEmbed(`${player.name}'s box`).setDescription(formatDrift && showDrift() ? `${FORMAT_DRIFT_WARNING}\n\n${message}` : message)],
      });
      return;
    }

    const totalPages = boxPageCount(player.pals);
    if (totalPages === 0) {
      await interaction.editReply({
        embeds: [baseEmbed(`${player.name}'s box`).setDescription(`This player has no box pages in the current save.${formatDrift && showDrift() ? `\n\n${FORMAT_DRIFT_WARNING}` : ""}`)],
      });
      return;
    }

    let page = Math.min(Math.max(1, requestedPage), totalPages);
    const assets = assetsFor(ctx.session);

    const render = async (target: number): Promise<InteractionEditReplyOptions> => {
      const zeroBased = target - 1;
      const pagePals = player.pals
        .filter((pal) => pal.boxPage === zeroBased)
        .sort((a, b) => (a.boxSlot ?? Number.MAX_SAFE_INTEGER) - (b.boxSlot ?? Number.MAX_SAFE_INTEGER));
      const embed = baseEmbed(`${player.name}'s box — page ${target}/${totalPages}`);
      if (formatDrift && showDrift()) embed.setDescription(FORMAT_DRIFT_WARNING);
      embed.addFields({ name: "Pals", value: cappedPalList(pagePals) });
      const components = totalPages > 1 ? [navRow(target, totalPages)] : [];

      if (pagePals.length === 0) return { embeds: [embed], files: [], components };
      const iconAssets = await Promise.all(pagePals.map((pal) => assets.palIcon(pal.characterId)));
      if (!iconAssets.some((asset) => asset !== null)) {
        embed.setFooter({ text: "Pal icons have not been fetched on the panel (scripts/fetch-pal-icons.sh)." });
        return { embeds: [embed], files: [], components };
      }
      const png = await renderPalGrid(
        pagePals,
        iconAssets.map((asset) => (asset ? asset.buffer : null)),
        { cols: BOX_COLS, rows: BOX_ROWS, slots: pagePals.map((pal) => pal.boxSlot) },
      );
      const fileName = `box-page-${target}.png`;
      embed.setImage(`attachment://${fileName}`);
      return { embeds: [embed], files: [new AttachmentBuilder(png, { name: fileName })], components };
    };

    const message = await interaction.editReply(await render(page));
    if (totalPages <= 1) return;

    // Anyone in the channel may flip pages — it's a shared browse. Buttons expire
    // after inactivity, then disable so a stale message can't be clicked forever.
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: COLLECTOR_MS });
    collector.on("collect", async (button) => {
      page = button.customId === "box_next" ? Math.min(totalPages, page + 1) : Math.max(1, page - 1);
      await button.update(await render(page)).catch(() => {});
    });
    collector.on("end", async () => {
      await interaction.editReply({ components: [navRow(page, totalPages, true)] }).catch(() => {});
    });
  },
};
