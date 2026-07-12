import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, formatDuration, truncate } from "../discord/embeds.js";
import type { PlayerSummary, RosterPal } from "../types.js";
import { snapshotWarning } from "../snapshots/presentation.js";

function resolvePlayer(players: PlayerSummary[], query: string): PlayerSummary | undefined {
  return (
    players.find((player) => player.uid === query) ??
    players.find((player) => player.name.toLowerCase() === query.toLowerCase())
  );
}

function playerStats(pals: RosterPal[], uid: string) {
  const owned = pals.filter((pal) => pal.ownerUid === uid);
  return {
    count: owned.length,
    alpha: owned.filter((pal) => pal.isAlpha).length,
    lucky: owned.filter((pal) => pal.isLucky).length,
    highest: owned.reduce((best, pal) => Math.max(best, pal.level), 0),
  };
}

export const compareCommand: Command = {
  helpCategory: "players",
  data: new SlashCommandBuilder()
    .setName("compare")
    .setDescription("Compare two current player cards")
    .addStringOption((option) =>
      option
        .setName("player-a")
        .setDescription("First player")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName("player-b")
        .setDescription("Second player")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction, ctx) {
    try {
      const focused = interaction.options.getFocused().toLowerCase();
      const snapshot = await ctx.snapshots.get();
      const choices = [...snapshot.players]
        .filter((player) => player.name.toLowerCase().includes(focused))
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
            a.uid.localeCompare(b.uid),
        )
        .slice(0, 25)
        .map((player) => ({ name: player.name.slice(0, 100), value: player.uid }));
      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const snapshot = await ctx.snapshots.get();
    const queryA = interaction.options.getString("player-a", true);
    const queryB = interaction.options.getString("player-b", true);
    const playerA = resolvePlayer(snapshot.players, queryA);
    const playerB = resolvePlayer(snapshot.players, queryB);

    if (!playerA || !playerB) {
      const missing = [!playerA ? queryA : null, !playerB ? queryB : null].filter(
        (query): query is string => query !== null,
      );
      await interaction.editReply({
        embeds: [
          baseEmbed("Player not found").setDescription(
            `No current player matching ${missing.map((query) => `**${truncate(query, 80)}**`).join(" or ")}.`,
          ),
        ],
      });
      return;
    }

    const a = playerStats(snapshot.pals, playerA.uid);
    const b = playerStats(snapshot.pals, playerB.uid);
    // Weekly movement, when history has accumulated. Rendered as a "(+N)" suffix.
    const trends = ctx.observations.trends(7 * 86_400_000, snapshot);
    const trendOf = (uid: string) => trends?.players.find((trend) => trend.uid === uid);
    const gain = (value: number, format: (value: number) => string = String) =>
      value > 0 ? ` _(+${format(value)})_` : "";
    const trendA = trendOf(playerA.uid);
    const trendB = trendOf(playerB.uid);
    const row = (label: string, left: string | number, right: string | number) =>
      `**${label}** — ${left} │ ${right}`;
    const rows = [
      row("Level", `${playerA.level}${gain(trendA?.levelGain ?? 0)}`, `${playerB.level}${gain(trendB?.levelGain ?? 0)}`),
      row(
        "Playtime",
        `${formatDuration(playerA.playtimeSec)}${gain(trendA?.playtimeGainSec ?? 0, formatDuration)}`,
        `${formatDuration(playerB.playtimeSec)}${gain(trendB?.playtimeGainSec ?? 0, formatDuration)}`,
      ),
      row("Current pals", `${a.count}${gain(trendA?.palGain ?? 0)}`, `${b.count}${gain(trendB?.palGain ?? 0)}`),
      row("Highest pal", a.highest > 0 ? `Lv ${a.highest}` : "—", b.highest > 0 ? `Lv ${b.highest}` : "—"),
      row("Alpha / Lucky", `${a.alpha} / ${a.lucky}`, `${b.alpha} / ${b.lucky}`),
      row("Guild", truncate(playerA.guildName ?? "—", 120), truncate(playerB.guildName ?? "—", 120)),
    ];
    if (playerA.captureTotal !== undefined || playerB.captureTotal !== undefined) {
      rows.splice(2, 0, row("Lifetime captures", playerA.captureTotal ?? "Unavailable", playerB.captureTotal ?? "Unavailable"));
    }
    if (playerA.uniquePalsCaptured !== undefined || playerB.uniquePalsCaptured !== undefined) {
      rows.splice(3, 0, row("Unique captured", playerA.uniquePalsCaptured ?? "Unavailable", playerB.uniquePalsCaptured ?? "Unavailable"));
    }
    const body = rows.join("\n");
    const warning = snapshotWarning(snapshot, ctx.config.suppressDriftNotices);
    const embed = baseEmbed(`⚔️ ${truncate(playerA.name, 90)} vs ${truncate(playerB.name, 90)}`)
      .setDescription(warning ? `${warning}\n\n${body}` : body)
      .setFooter({
        text: `${truncate(playerA.name, 45)} │ ${truncate(playerB.name, 45)} · Snapshot ${new Date(snapshot.capturedAt).toUTCString()}`,
      });

    await interaction.editReply({ embeds: [embed] });
  },
};
