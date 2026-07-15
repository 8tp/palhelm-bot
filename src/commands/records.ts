import { ActionRowBuilder, ComponentType, SlashCommandBuilder, StringSelectMenuBuilder } from "discord.js";
import type { APIEmbedField, InteractionEditReplyOptions } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, discordRelative, formatDuration, truncate } from "../discord/embeds.js";
import { snapshotWarning } from "../snapshots/presentation.js";
import { palOwnerLabel, palVariantTags } from "../pals/presentation.js";

const COLLECTOR_MS = 180_000;
export type RecordSection = "overview" | "players" | "pals" | "guilds" | "changes";
const RECORD_SECTIONS: Record<RecordSection, string> = {
  overview: "Overview",
  players: "Player records",
  pals: "Pal records",
  guilds: "Guild records",
  changes: "Holder changes",
};

function recordSectionRow(customId: string, current: RecordSection, disabled = false): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Choose a record category").setDisabled(disabled)
      .addOptions((Object.entries(RECORD_SECTIONS) as [RecordSection, string][]).map(([value, label]) => ({ label, value, default: value === current }))),
  );
}

export function recordControlError(expected: string, actual: string, requester: string, actor: string, section?: string): string | null {
  if (actual !== expected) return "That records control is no longer valid.";
  if (requester !== actor) return "Only the person who opened these records can change the category.";
  if (!section || !(section in RECORD_SECTIONS)) return "That records category is no longer valid.";
  return null;
}

export const recordsCommand: Command = {
  helpCategory: "records",
  data: new SlashCommandBuilder()
    .setName("records")
    .setDescription("Current server records"),

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const snapshot = await ctx.snapshots.get();
    const embed = baseEmbed(`📚 ${ctx.config.serverLabel} Records`);
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

    const highestOwner = highestPal ? palOwnerLabel(highestPal, snapshot.players) : "";
    const palFields: APIEmbedField[] = [{
        name: "Highest-level Pal",
        value: highestPal
          ? `Lv ${highestPal.level} ${truncate(highestPal.displayName, 70)}${palVariantTags(highestPal)} — ${truncate(highestOwner, 70)}`
          : "—",
      }, {
        name: "Largest current roster",
        value: topCount(rosterCounts),
        inline: true,
      },
      { name: "Alpha collector", value: topCount(alphaCounts), inline: true },
      { name: "Lucky collector", value: topCount(luckyCounts), inline: true }];
    const topLevel = [...snapshot.players].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))[0];
    const playerFields: APIEmbedField[] = [{
        name: "Highest player level",
        value: topLevel ? `${truncate(topLevel.name, 80)} — Lv ${topLevel.level}` : "—",
        inline: true,
      }, {
        name: "Longest playtime",
        value: longestPlaytime ? `${truncate(longestPlaytime.name, 80)} — ${formatDuration(longestPlaytime.playtimeSec)}` : "—",
        inline: true,
      }, {
        name: "Longest-standing player",
        value: longestStanding ? `${truncate(longestStanding.name, 80)} — first seen ${discordRelative(longestStanding.firstSeenAt)}` : "—",
        inline: true,
      }];
    const guildFields: APIEmbedField[] = [{
        name: "Largest guild",
        value: largestGuild ? `${truncate(largestGuild.name, 80)} — ${largestGuild.memberCount} members · ${largestGuild.bases.length} bases` : "—",
        inline: true,
      }];
    const changes = ctx.observations.recordHistory(20);
    const changeFields: APIEmbedField[] = [{
      name: "Observed holder changes",
      value: changes.length === 0 ? "No holder changes have been observed yet." : truncate(changes.map((change) =>
        `🏆 **${truncate(change.playerName ?? "Unknown", 60)}** passed **${truncate(change.previousPlayerName ?? "Unknown", 60)}** for ${truncate(change.recordLabel ?? "a record", 80)} · ${truncate(change.recordDetail ?? "", 80)}${change.observedAt ? ` · ${discordRelative(change.observedAt)}` : ""}`
      ).join("\n"), 1024),
    }];
    let section: RecordSection = "overview";
    const customId = `records_section:${interaction.id}`;
    const render = (current: RecordSection, disabled = false): InteractionEditReplyOptions => {
      const fields = current === "players" ? playerFields
        : current === "pals" ? palFields
          : current === "guilds" ? guildFields
            : current === "changes" ? changeFields
              : [...palFields.slice(0, 1), ...playerFields, ...palFields.slice(1), ...guildFields, ...(changes.length ? changeFields : [])];
      const currentEmbed = baseEmbed(`📚 ${ctx.config.serverLabel} Records${current === "overview" ? "" : ` · ${RECORD_SECTIONS[current]}`}`)
        .addFields(fields)
        .setFooter({ text: `Current snapshot · holder changes are observed${trackingStartedAt ? ` since ${new Date(trackingStartedAt).toLocaleDateString()}` : " after tracking begins"}` });
      if (warning) currentEmbed.setDescription(warning);
      return { embeds: [currentEmbed], components: [recordSectionRow(customId, current, disabled)] };
    };
    const message = await interaction.editReply(render(section));
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: COLLECTOR_MS });
    collector.on("collect", async (select) => {
      const next = select.values[0];
      const rejection = recordControlError(customId, select.customId, interaction.user.id, select.user.id, next);
      if (rejection) {
        await select.reply({ content: rejection, ephemeral: true }).catch(() => {});
        return;
      }
      section = next as RecordSection;
      await select.update(render(section)).catch(() => {});
    });
    collector.on("end", async () => {
      await interaction.editReply(render(section, true)).catch(() => {});
    });
  },
};
