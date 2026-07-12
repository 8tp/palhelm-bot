import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { ringPng } from "../discord/charts.js";
import { snapshotWarning } from "../snapshots/presentation.js";
import { isBossVariant } from "../pals/presentation.js";
import { exactKnowledgeFor, metadataLabel, readyKnowledge } from "./pal-toolbox.js";

export const collectionCommand: Command = {
  helpCategory: "pals",
  data: new SlashCommandBuilder()
    .setName("collection")
    .setDescription("Paldeck completion for the server or one player")
    .addStringOption((option) =>
      option.setName("player").setDescription("Optional player collection").setRequired(false).setAutocomplete(true),
    ),

  async autocomplete(interaction, ctx) {
    try {
      const focused = interaction.options.getFocused().toLowerCase();
      const snapshot = await ctx.snapshots.get();
      await interaction.respond(snapshot.players
        .filter((player) => player.name.toLowerCase().includes(focused))
        .sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid))
        .slice(0, 25)
        .map((player) => ({ name: player.name.slice(0, 100), value: player.uid })));
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    try {
      await readyKnowledge(ctx.knowledge);
    } catch {
      await interaction.editReply({ embeds: [baseEmbed("Pal knowledge unavailable").setDescription("The pinned Palworld 1.0 catalogue is temporarily unavailable.")] });
      return;
    }
    const snapshot = await ctx.snapshots.get();
    const query = interaction.options.getString("player");
    const player = query
      ? snapshot.players.find((item) => item.uid === query) ?? snapshot.players.find((item) => item.name.toLowerCase() === query.toLowerCase())
      : null;
    if (query && !player) {
      await interaction.editReply({ embeds: [baseEmbed("Player not found").setDescription(`No current player matching **${truncate(query, 100)}**.`)] });
      return;
    }

    const pals = player ? snapshot.pals.filter((pal) => pal.ownerUid === player.uid) : snapshot.pals;
    const catalogue = ctx.knowledge.list().data;
    const observed = new Map<string, { name: string; count: number; alpha: boolean; boss: boolean; lucky: boolean }>();
    let unmapped = 0;
    for (const pal of pals) {
      const known = exactKnowledgeFor(ctx.knowledge, pal.characterId, pal.displayName);
      if (!known) {
        unmapped++;
        continue;
      }
      const key = known.internalId.toLocaleLowerCase("en-US");
      const entry = observed.get(key) ?? { name: known.name, count: 0, alpha: false, boss: false, lucky: false };
      entry.count++;
      entry.alpha ||= pal.isAlpha;
      entry.boss ||= isBossVariant(pal);
      entry.lucky ||= pal.isLucky;
      observed.set(key, entry);
    }
    const total = catalogue.length;
    const complete = observed.size;
    const percentage = total ? (complete / total) * 100 : 0;
    const missing = catalogue.filter((pal) => !observed.has(pal.internalId.toLocaleLowerCase("en-US")));
    const rare = [...observed.values()];
    const bosses = rare.filter((item) => item.boss).length;
    const alphas = rare.filter((item) => item.alpha && !item.boss).length;
    const luckies = rare.filter((item) => item.lucky).length;
    const observedLines = [...observed.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 15).map(
      (item) => `${item.name}${item.boss ? " 👑" : item.alpha ? " ⭐" : ""}${item.lucky ? " 🍀" : ""}${item.count > 1 ? ` ×${item.count}` : ""}`,
    );
    const missingLines = missing.slice(0, 15).map((pal) => `#${pal.dexNumber}${pal.isVariant ? "v" : ""} ${pal.name}`);
    const nextMissing = missing[0];
    const missingHint = nextMissing
      ? `**Try next:** inspect **${nextMissing.name}** with \`/dex pal:${nextMissing.internalId}\`, then check owned breeding pairs with \`/breed child:${nextMissing.internalId}\`.`
      : "";
    const warning = snapshotWarning(snapshot, ctx.config.suppressDriftNotices);
    const body = [
      `**${complete} / ${total} species (${percentage.toFixed(1)}%)** · ${pals.length} current Pal instances`,
      `${bosses} Boss species 👑 · ${alphas} Alpha species ⭐ · ${luckies} Lucky species 🍀`,
      unmapped ? `${unmapped} current instance${unmapped === 1 ? "" : "s"} could not be matched to the pinned catalogue.` : "",
      "",
      observedLines.length ? `**Observed (${observed.size})**\n${observedLines.join("\n")}${observed.size > observedLines.length ? `\n…and ${observed.size - observedLines.length} more` : ""}` : "**Observed (0)**\nNone",
      "",
      missing.length ? `**Missing (${missing.length})**\n${missingLines.join("\n")}${missing.length > missingLines.length ? `\n…and ${missing.length - missingLines.length} more` : ""}` : "🎉 **Paldeck complete!**",
      missingHint ? `\n${missingHint}` : "",
    ].join("\n");
    const embed = baseEmbed(player ? `📗 ${truncate(player.name, 210)}'s Collection` : `📗 ${ctx.config.serverLabel} collection`)
      .setDescription(truncate(warning ? `${warning}\n\n${body}` : body, 4096))
      .setFooter({ text: truncate(`${metadataLabel(ctx.knowledge)} · Current save holdings`, 2048) });
    const files: AttachmentBuilder[] = [];
    if (total > 0) {
      embed.setThumbnail("attachment://collection.png");
      files.push(new AttachmentBuilder(await ringPng("Paldeck", complete, total), { name: "collection.png" }));
    }
    await interaction.editReply({ embeds: [embed], files });
  },
};
