import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { baseCharacterId, palOwnerLabel, palVariantTags } from "../pals/presentation.js";
import type { PalKnowledge } from "../knowledge/paldeck.js";
import type { RosterPal } from "../types.js";

const BASE_ROLES = ["Handiwork", "Mining", "Transporting", "Generating Electricity", "Watering", "Kindling", "Planting", "Medicine Production"];

export const teamCommand: Command = {
  helpCategory: "breeding",
  data: new SlashCommandBuilder()
    .setName("team")
    .setDescription("Recommend a combat party or base role leaders from current Pals")
    .addStringOption((option) => option.setName("purpose").setDescription("Recommendation purpose").setRequired(true)
      .addChoices({ name: "Combat party", value: "combat" }, { name: "Base role leaders", value: "base" }))
    .addStringOption((option) => option.setName("player").setDescription("Optional exact player name").setAutocomplete(true)),

  async autocomplete(interaction, ctx) {
    try {
      const focused = interaction.options.getFocused().toLowerCase();
      const snapshot = await ctx.snapshots.get();
      await interaction.respond(snapshot.players.filter((player) => player.name.toLowerCase().includes(focused))
        .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25)
        .map((player) => ({ name: player.name.slice(0, 100), value: player.uid })));
    } catch { await interaction.respond([]); }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const snapshot = await ctx.snapshots.get();
    const query = interaction.options.getString("player");
    const player = query ? snapshot.players.find((item) => item.uid === query) ?? snapshot.players.find((item) => item.name.toLowerCase() === query.toLowerCase()) : null;
    if (query && !player) {
      await interaction.editReply({ embeds: [baseEmbed("Player not found").setDescription("No current player matched that name.")] });
      return;
    }
    await ctx.knowledge.init();
    const roster = snapshot.pals.filter((pal) => !player || pal.ownerUid === player.uid);
    const known = roster.map((pal) => ({ pal, knowledge: exactKnowledge(ctx.knowledge.get(baseCharacterId(pal.characterId)).data, pal) }))
      .filter((item): item is { pal: RosterPal; knowledge: PalKnowledge } => item.knowledge !== null);
    const subject = player?.name ?? ctx.config.serverLabel;
    if (known.length === 0) {
      await interaction.editReply({ embeds: [baseEmbed("No recommendation available").setDescription("No current roster entries matched the pinned Palworld 1.0 catalogue.")] });
      return;
    }
    const purpose = interaction.options.getString("purpose", true);
    if (purpose === "combat") {
      const ranked = known.sort((a, b) => combatScore(b) - combatScore(a) || b.pal.level - a.pal.level).slice(0, 5);
      const lines = ranked.map(({ pal, knowledge }, index) => {
        const owner = palOwnerLabel(pal, snapshot.players);
        return `**${index + 1}.** Lv ${pal.level} ${knowledge.name}${palVariantTags(pal)} · ${knowledge.elements.join("/") || "Unknown"} · ${truncate(owner, 50)}`;
      });
      await interaction.editReply({ embeds: [baseEmbed(`⚔️ ${subject} Combat Party`).setDescription(lines.join("\n"))
        .setFooter({ text: "Heuristic: base HP + attack + defense, rarity, then current Pal level · not a matchup simulator" })] });
      return;
    }

    const leaders = BASE_ROLES.map((role) => {
      const candidates = known.map((item) => ({ item, work: item.knowledge.workSuitabilities.find((work) => work.name === role) }))
        .filter((value): value is { item: { pal: RosterPal; knowledge: PalKnowledge }; work: PalKnowledge["workSuitabilities"][number] } => value.work !== undefined)
        .sort((a, b) => b.work.level - a.work.level || b.item.pal.level - a.item.pal.level);
      return candidates[0] ? { role, ...candidates[0] } : null;
    }).filter((value): value is NonNullable<typeof value> => value !== null);
    const lines = leaders.map(({ role, item, work }) => {
      const owner = palOwnerLabel(item.pal, snapshot.players);
      return `**${role} ${work.level}** — Lv ${item.pal.level} ${item.knowledge.name}${palVariantTags(item.pal)} · ${truncate(owner, 45)}`;
    });
    await interaction.editReply({ embeds: [baseEmbed(`🏠 ${subject} Base Role Leaders`).setDescription(lines.length > 0 ? lines.join("\n") : "No suitable workers were found.")
      .setFooter({ text: "One strongest current candidate per essential role · use /workers for a full ranking" })] });
  },
};

function exactKnowledge(known: PalKnowledge | null, pal: RosterPal): PalKnowledge | null {
  return known?.internalId.toLowerCase() === baseCharacterId(pal.characterId).toLowerCase() ? known : null;
}

function combatScore(item: { pal: RosterPal; knowledge: PalKnowledge }): number {
  return (item.knowledge.hp + item.knowledge.attack + item.knowledge.defense) * 100 + item.knowledge.rarity * 10 + item.pal.level;
}
