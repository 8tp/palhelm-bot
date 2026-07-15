import {
  ActionRowBuilder,
  AttachmentBuilder,
  ComponentType,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { InteractionEditReplyOptions } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, formatDuration, truncate } from "../discord/embeds.js";
import { barChartPng, type BarItem } from "../discord/charts.js";
import type { PlayerSummary, RosterPal } from "../types.js";
import type { WorldSnapshot } from "../snapshots/service.js";
import { snapshotWarning } from "../snapshots/presentation.js";

const MAX_ROWS = 15;
const COLLECTOR_MS = 180_000;
type Category = "level" | "playtime" | "pals" | "alpha" | "lucky" | "captures" | "unique" | "paldeck" | "guild";

const CATEGORY_LABELS: Record<Category, string> = {
  level: "Player level",
  playtime: "Playtime",
  pals: "Current pals",
  alpha: "Current Alpha pals",
  lucky: "Current Lucky pals",
  captures: "Lifetime captures",
  unique: "Unique species captured",
  paldeck: "Paldeck unlocked",
  guild: "Guild size",
};

function playerCounts(pals: RosterPal[], predicate: (pal: RosterPal) => boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pal of pals) {
    if (predicate(pal)) counts.set(pal.ownerUid, (counts.get(pal.ownerUid) ?? 0) + 1);
  }
  return counts;
}

function comparePlayers(score: (player: PlayerSummary) => number): (a: PlayerSummary, b: PlayerSummary) => number {
  return (a, b) =>
    score(b) - score(a) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
    a.uid.localeCompare(b.uid);
}

interface Ranking {
  lines: string[];
  items: BarItem[];
  rankedCount: number;
}

function rankCategory(snapshot: WorldSnapshot, category: Category): Ranking {
  if (category === "guild") {
    const ranked = [...snapshot.guilds].sort(
      (a, b) =>
        b.memberCount - a.memberCount ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
    const shown = ranked.slice(0, MAX_ROWS);
    return {
      rankedCount: ranked.length,
      lines: shown.map((guild, index) => `**${index + 1}.** ${truncate(guild.name, 80)} — ${guild.memberCount} member${guild.memberCount === 1 ? "" : "s"}`),
      items: shown.map((guild) => ({ label: guild.name, value: guild.memberCount, display: `${guild.memberCount}` })),
    };
  }

  const counts = playerCounts(snapshot.pals, (pal) => {
    if (category === "alpha") return pal.isAlpha;
    if (category === "lucky") return pal.isLucky;
    return true;
  });
  const score = (player: PlayerSummary): number => {
    if (category === "level") return player.level;
    if (category === "playtime") return player.playtimeSec;
    if (category === "captures") return player.captureTotal ?? 0;
    if (category === "unique") return player.uniquePalsCaptured ?? 0;
    if (category === "paldeck") return player.paldeckUnlocked ?? 0;
    return counts.get(player.uid) ?? 0;
  };
  const valueText = (player: PlayerSummary): string => {
    const n = score(player);
    if (category === "level") return `Lv ${n}`;
    if (category === "playtime") return formatDuration(n);
    if (category === "captures") return `${n} lifetime captures`;
    if (category === "unique") return `${n} unique captured`;
    if (category === "paldeck") return `${n} Paldeck entries`;
    return `${n} pal${n === 1 ? "" : "s"}`;
  };
  const shortValue = (player: PlayerSummary): string => (category === "playtime" ? formatDuration(score(player)) : `${score(player)}`);

  const progression = category === "captures" || category === "unique" || category === "paldeck";
  const ranked = snapshot.players
    .filter((player) => !progression || (
      category === "captures" ? player.captureTotal !== undefined
        : category === "unique" ? player.uniquePalsCaptured !== undefined
          : player.paldeckUnlocked !== undefined
    ))
    .sort(comparePlayers(score));
  const shown = ranked.slice(0, MAX_ROWS);
  return {
    rankedCount: ranked.length,
    lines: shown.map((player, index) => `**${index + 1}.** ${truncate(player.name, 80)} — ${valueText(player)}`),
    items: shown.map((player) => ({ label: player.name, value: score(player), display: shortValue(player) })),
  };
}

function categoryRow(current: Category): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("lb_category")
    .setPlaceholder("Change ranking")
    .addOptions(
      (Object.entries(CATEGORY_LABELS) as [Category, string][]).map(([value, label]) => ({
        label,
        value,
        default: value === current,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export const leaderboardCommand: Command = {
  helpCategory: "records",
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Rank current players or guilds (switch categories from the menu)")
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription("Ranking to show (defaults to player level)")
        .setRequired(false)
        .addChoices(...(Object.entries(CATEGORY_LABELS) as [Category, string][]).map(([value, name]) => ({ name, value }))),
    ),

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const snapshot = await ctx.snapshots.get();
    const warning = snapshotWarning(snapshot, ctx.config.suppressDriftNotices);

    const render = async (category: Category): Promise<InteractionEditReplyOptions> => {
      const { lines, items, rankedCount } = rankCategory(snapshot, category);
      const title = `🏆 ${ctx.config.serverLabel} Leaderboard — ${CATEGORY_LABELS[category]}`;
      const omitted = rankedCount - lines.length;
      const body = lines.length > 0
        ? [...lines, ...(omitted > 0 ? [`…and ${omitted} more`] : [])].join("\n")
        : "No ranking data is available yet.";
      const embed = baseEmbed(title)
        .setDescription(warning ? `${warning}\n\n${body}` : body)
        .setFooter({ text: `Snapshot ${new Date(snapshot.capturedAt).toUTCString()}` });
      const files: AttachmentBuilder[] = [];
      if (items.length > 0) {
        const png = await barChartPng(CATEGORY_LABELS[category], items);
        embed.setImage("attachment://leaderboard.png");
        files.push(new AttachmentBuilder(png, { name: "leaderboard.png" }));
      }
      return { embeds: [embed], files, components: [categoryRow(category)] };
    };

    let category = (interaction.options.getString("category") ?? "level") as Category;
    const message = await interaction.editReply(await render(category));

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: COLLECTOR_MS });
    collector.on("collect", async (select) => {
      category = select.values[0] as Category;
      await select.update(await render(category)).catch(() => {});
    });
    collector.on("end", async () => {
      await interaction.editReply({ components: [] }).catch(() => {});
    });
  },
};
