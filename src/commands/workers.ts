import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { palOwnerLabel, palVariantTags } from "../pals/presentation.js";
import { exactKnowledgeFor, metadataLabel, readyKnowledge } from "./pal-toolbox.js";

const JOBS = [
  "Kindling", "Watering", "Planting", "Generating Electricity", "Handiwork", "Gathering",
  "Lumbering", "Mining", "Medicine Production", "Cooling", "Transporting", "Farming",
] as const;

export const workersCommand: Command = {
  helpCategory: "breeding",
  data: new SlashCommandBuilder()
    .setName("workers")
    .setDescription("Rank currently owned Pals for a base job")
    .addStringOption((option) => option.setName("job").setDescription("Base work suitability").setRequired(true)
      .addChoices(...JOBS.map((job) => ({ name: job, value: job }))))
    .addStringOption((option) => option.setName("player").setDescription("Optional player roster").setRequired(false).setAutocomplete(true)),

  async autocomplete(interaction, ctx) {
    try {
      const query = interaction.options.getFocused().toLowerCase();
      const snapshot = await ctx.snapshots.get();
      await interaction.respond(snapshot.players.filter((player) => player.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25)
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
      await interaction.editReply({ embeds: [baseEmbed("Pal knowledge unavailable").setDescription("The pinned Palworld 1.0 work catalogue is temporarily unavailable.")] });
      return;
    }
    const job = interaction.options.getString("job", true);
    const playerQuery = interaction.options.getString("player");
    const snapshot = await ctx.snapshots.get();
    const player = playerQuery
      ? snapshot.players.find((item) => item.uid === playerQuery) ?? snapshot.players.find((item) => item.name.toLowerCase() === playerQuery.toLowerCase())
      : null;
    if (playerQuery && !player) {
      await interaction.editReply({ embeds: [baseEmbed("Player not found").setDescription(`No current player matching **${truncate(playerQuery, 100)}**.`)] });
      return;
    }
    const normalizedJob = job.toLocaleLowerCase("en-US");
    const candidates = snapshot.pals.flatMap((pal) => {
      if (player && pal.ownerUid !== player.uid) return [];
      const known = exactKnowledgeFor(ctx.knowledge, pal.characterId, pal.displayName);
      const work = known?.workSuitabilities.find((item) => item.name.toLocaleLowerCase("en-US") === normalizedJob || item.id.toLocaleLowerCase("en-US") === normalizedJob);
      return known && work ? [{ pal, known, work }] : [];
    }).sort((a, b) => b.work.level - a.work.level || b.pal.level - a.pal.level || a.known.name.localeCompare(b.known.name) || a.pal.instanceId.localeCompare(b.pal.instanceId));
    if (!candidates.length) {
      await interaction.editReply({ embeds: [baseEmbed(`🛠️ ${job} workers`).setDescription(`${player ? `${player.name} does` : `${ctx.config.serverLabel} does`} not currently have an observed Pal capable of **${job}**.`)] });
      return;
    }
    const shown = candidates.slice(0, 15);
    const lines = shown.map(({ pal, known, work }, index) => {
      const owner = palOwnerLabel(pal, snapshot.players);
      return `${index + 1}. **${known.name}${palVariantTags(pal)}** — ${job} Lv ${work.level} · Pal Lv ${pal.level}\n${truncate(owner, 90)}${pal.inParty ? " · in party" : ""}`;
    });
    const embed = baseEmbed(`🛠️ Best ${job} workers`)
      .setDescription(truncate(`${player ? `Current roster: **${player.name}**` : `All current rosters on ${ctx.config.serverLabel}`}\n\n${lines.join("\n")}${candidates.length > shown.length ? `\n…and ${candidates.length - shown.length} more` : ""}`, 4096))
      .setFooter({ text: truncate(`${metadataLabel(ctx.knowledge)} · Ranked by work level, then Pal level`, 2048) });
    await interaction.editReply({ embeds: [embed] });
  },
};
