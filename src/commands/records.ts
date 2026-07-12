import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, discordRelative, formatDuration, truncate } from "../discord/embeds.js";
import { snapshotWarning } from "../snapshots/presentation.js";
import { palOwnerLabel, palVariantTags } from "../pals/presentation.js";

export const recordsCommand: Command = {
  helpCategory: "records",
  data: new SlashCommandBuilder()
    .setName("records")
    .setDescription("Current server records"),

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const snapshot = await ctx.snapshots.get();
    const embed = baseEmbed(`📚 ${ctx.config.serverLabel} records`);
    const warning = snapshotWarning(snapshot, ctx.config.suppressDriftNotices);
    const trackingStartedAt = ctx.observations.trackingStartedAt();

    if (snapshot.players.length === 0 && snapshot.pals.length === 0) {
      embed.setDescription(warning ? `${warning}\n\nNo record data is available yet.` : "No record data is available yet.");
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const rosterCounts = new Map<string, number>();
    const alphaCounts = new Map<string, number>();
    const luckyCounts = new Map<string, number>();
    for (const pal of snapshot.pals) {
      rosterCounts.set(pal.ownerUid, (rosterCounts.get(pal.ownerUid) ?? 0) + 1);
      if (pal.isAlpha) alphaCounts.set(pal.ownerUid, (alphaCounts.get(pal.ownerUid) ?? 0) + 1);
      if (pal.isLucky) luckyCounts.set(pal.ownerUid, (luckyCounts.get(pal.ownerUid) ?? 0) + 1);
    }
    const playerName = new Map(snapshot.players.map((player) => [player.uid, player.name]));
    const highestPal = [...snapshot.pals].sort(
      (a, b) => b.level - a.level || a.displayName.localeCompare(b.displayName) || a.instanceId.localeCompare(b.instanceId),
    )[0];
    const longestPlaytime = [...snapshot.players].sort(
      (a, b) => b.playtimeSec - a.playtimeSec || a.name.localeCompare(b.name),
    )[0];
    const longestStanding = [...snapshot.players].sort(
      (a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) || a.name.localeCompare(b.name),
    )[0];
    const largestGuild = [...snapshot.guilds].sort(
      (a, b) => b.memberCount - a.memberCount || b.bases.length - a.bases.length || a.name.localeCompare(b.name),
    )[0];

    const topCount = (counts: Map<string, number>): string => {
      const [uid, count] = [...counts].sort(
        ([uidA, countA], [uidB, countB]) => countB - countA || (playerName.get(uidA) ?? uidA).localeCompare(playerName.get(uidB) ?? uidB),
      )[0] ?? [];
      return uid === undefined ? "—" : `${truncate(playerName.get(uid) ?? "Unknown", 80)} — ${count}`;
    };

    if (warning) embed.setDescription(warning);
    const highestOwner = highestPal ? palOwnerLabel(highestPal, snapshot.players) : "";
    embed.addFields(
      {
        name: "Highest-level Pal",
        value: highestPal
          ? `Lv ${highestPal.level} ${truncate(highestPal.displayName, 70)}${palVariantTags(highestPal)} — ${truncate(highestOwner, 70)}`
          : "—",
      },
      {
        name: "Largest current roster",
        value: topCount(rosterCounts),
        inline: true,
      },
      { name: "Alpha collector", value: topCount(alphaCounts), inline: true },
      { name: "Lucky collector", value: topCount(luckyCounts), inline: true },
      {
        name: "Longest playtime",
        value: longestPlaytime ? `${truncate(longestPlaytime.name, 80)} — ${formatDuration(longestPlaytime.playtimeSec)}` : "—",
        inline: true,
      },
      {
        name: "Longest-standing player",
        value: longestStanding ? `${truncate(longestStanding.name, 80)} — first seen ${discordRelative(longestStanding.firstSeenAt)}` : "—",
        inline: true,
      },
      {
        name: "Largest guild",
        value: largestGuild ? `${truncate(largestGuild.name, 80)} — ${largestGuild.memberCount} members · ${largestGuild.bases.length} bases` : "—",
        inline: true,
      },
    );
    embed.setFooter({
      text: `Current snapshot · holder changes are observed${trackingStartedAt ? ` since ${new Date(trackingStartedAt).toLocaleDateString()}` : " after tracking begins"}`,
    });
    await interaction.editReply({ embeds: [embed] });
  },
};
