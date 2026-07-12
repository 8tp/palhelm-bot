import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  SlashCommandBuilder,
} from "discord.js";
import type { InteractionEditReplyOptions } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import type { BreedingOutcome, PalGender, PalKnowledge } from "../knowledge/paldeck.js";
import type { RosterPal } from "../types.js";
import { exactKnowledgeFor, metadataLabel, readyKnowledge } from "./pal-toolbox.js";
import { findOwnedBreedingMatch, genderCounts } from "../breeding/owned.js";

interface RankedPair { outcome: BreedingOutcome; first: RosterPal[]; second: RosterPal[] }

const PAGE_SIZE = 6;
const COLLECTOR_MS = 180_000;

export function breedPageRange(total: number, requestedPage: number): { page: number; pageCount: number; start: number; end: number } {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, requestedPage));
  const start = (page - 1) * PAGE_SIZE;
  return { page, pageCount, start, end: Math.min(total, start + PAGE_SIZE) };
}

function controlIds(interactionId: string): { previous: string; next: string } {
  return { previous: `breed_prev:${interactionId}`, next: `breed_next:${interactionId}` };
}

export function breedControlError(
  expected: { previous: string; next: string },
  actualCustomId: string,
  requesterId: string,
  actorId: string,
): string | null {
  if (actualCustomId !== expected.previous && actualCustomId !== expected.next) return "That breeding control is no longer valid.";
  if (actorId !== requesterId) return "Only the person who opened this breeding guide can change its page.";
  return null;
}

export function breedNavigationRow(interactionId: string, page: number, pageCount: number, disableAll = false): ActionRowBuilder<ButtonBuilder> {
  const ids = controlIds(interactionId);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.previous).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(disableAll || page <= 1),
    new ButtonBuilder().setCustomId(`breed_page:${interactionId}`).setLabel(`Page ${page}/${pageCount}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(ids.next).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(disableAll || page >= pageCount),
  );
}

export const breedCommand: Command = {
  helpCategory: "breeding",
  data: new SlashCommandBuilder()
    .setName("breed")
    .setDescription("Find breeding pairs for a Pal, ranked by what the server owns")
    .addStringOption((option) => option.setName("child").setDescription("Desired child Pal").setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName("player").setDescription("Rank using only one player's Pals").setRequired(false).setAutocomplete(true)),

  async autocomplete(interaction, ctx) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name === "player") {
        const snapshot = await ctx.snapshots.get();
        const query = String(focused.value).toLowerCase();
        await interaction.respond(snapshot.players.filter((player) => player.name.toLowerCase().includes(query)).slice(0, 25)
          .map((player) => ({ name: player.name.slice(0, 100), value: player.uid })));
        return;
      }
      await readyKnowledge(ctx.knowledge);
      await interaction.respond(ctx.knowledge.search(String(focused.value), 25).data.map((pal) => ({
        name: truncate(`#${pal.dexNumber}${pal.isVariant ? " variant" : ""} · ${pal.name}`, 100),
        value: pal.internalId.slice(0, 100),
      })));
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    try {
      await readyKnowledge(ctx.knowledge);
    } catch {
      await interaction.editReply({ embeds: [baseEmbed("Pal knowledge unavailable").setDescription("The pinned Palworld 1.0 breeding catalogue is temporarily unavailable.")] });
      return;
    }
    const childQuery = interaction.options.getString("child", true);
    const playerQuery = interaction.options.getString("player");
    const snapshot = await ctx.snapshots.get();
    const player = playerQuery
      ? snapshot.players.find((item) => item.uid === playerQuery) ?? snapshot.players.find((item) => item.name.toLowerCase() === playerQuery.toLowerCase())
      : null;
    if (playerQuery && !player) {
      await interaction.editReply({ embeds: [baseEmbed("Player not found").setDescription(`No current player matching **${truncate(playerQuery, 100)}**.`)] });
      return;
    }
    const child = ctx.knowledge.get(childQuery).data;
    if (!child) {
      await interaction.editReply({ embeds: [baseEmbed("Pal not found").setDescription(`No Palworld 1.0 Pal matched **${truncate(childQuery, 100)}**.`)] });
      return;
    }
    const roster = player ? snapshot.pals.filter((pal) => pal.ownerUid === player.uid) : snapshot.pals;
    const ownership = new Map<string, RosterPal[]>();
    for (const pal of roster) {
      const known = exactKnowledgeFor(ctx.knowledge, pal.characterId, pal.displayName);
      if (!known) continue;
      const key = known.internalId.toLowerCase();
      ownership.set(key, [...(ownership.get(key) ?? []), pal]);
    }
    const pairs = deduplicate(ctx.knowledge.parentsFor(child.internalId, 500).data).map((outcome): RankedPair => ({
      outcome,
      first: ownership.get(outcome.parent1.internalId.toLowerCase()) ?? [],
      second: ownership.get(outcome.parent2.internalId.toLowerCase()) ?? [],
    })).sort(comparePair);
    if (!pairs.length) {
      await interaction.editReply({ embeds: [baseEmbed(`🥚 ${child.name}`).setDescription("No breeding pairs were found in the pinned Palworld 1.0 dataset.")] });
      return;
    }
    const scope = player ? `${player.name}'s current roster` : `all current rosters on ${ctx.config.serverLabel}`;
    const pageCount = breedPageRange(pairs.length, 1).pageCount;
    let page = 1;
    const render = (target: number, disableAll = false): InteractionEditReplyOptions => {
      const { start, end } = breedPageRange(pairs.length, target);
      const lines = pairs.slice(start, end).map((pair, index) => {
        const available = pairAvailability(pair);
        const mark = available === 3 ? "✅" : available === 2 ? "⚠️" : available === 1 ? "◐" : "○";
        return `${start + index + 1}. ${mark} **${parentLabel(pair.outcome.parent1, pair.outcome.parent1Gender)}** + **${parentLabel(pair.outcome.parent2, pair.outcome.parent2Gender)}**\n${ownershipLabel(pair)}`;
      });
      const embed = baseEmbed(`🥚 Breeding ${truncate(child.name, 220)}`)
        .setDescription(truncate(`Ownership scope: **${scope}**. ✅ compatible ♂+♀ pair · ⚠️ species owned but genders incompatible/unknown · ◐ one parent · ○ neither\n\n${lines.join("\n\n")}`, 4096))
        .setFooter({ text: truncate(`${metadataLabel(ctx.knowledge)} · ${pairs.length} unique combinations · page ${target}/${pageCount}`, 2048) });
      return { embeds: [embed], components: pageCount > 1 ? [breedNavigationRow(interaction.id, target, pageCount, disableAll)] : [] };
    };

    const message = await interaction.editReply(render(page));
    if (pageCount <= 1) return;
    const ids = controlIds(interaction.id);
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: COLLECTOR_MS });
    collector.on("collect", async (button) => {
      const rejection = breedControlError(ids, button.customId, interaction.user.id, button.user.id);
      if (rejection) {
        await button.reply({ content: rejection, ephemeral: true }).catch(() => {});
        return;
      }
      page = button.customId === ids.next ? Math.min(pageCount, page + 1) : Math.max(1, page - 1);
      await button.update(render(page)).catch(() => {});
    });
    collector.on("end", async () => {
      await interaction.editReply(render(page, true)).catch(() => {});
    });
  },
};

function deduplicate(outcomes: BreedingOutcome[]): BreedingOutcome[] {
  const unique = new Map<string, BreedingOutcome>();
  for (const result of outcomes) {
    const parents = [
      `${result.parent1.internalId.toLowerCase()}:${result.parent1Gender}`,
      `${result.parent2.internalId.toLowerCase()}:${result.parent2Gender}`,
    ].sort();
    unique.set(parents.join("+"), result);
  }
  return [...unique.values()];
}

function comparePair(a: RankedPair, b: RankedPair): number {
  const availabilityA = pairAvailability(a);
  const availabilityB = pairAvailability(b);
  return availabilityB - availabilityA ||
    Math.max(a.outcome.parent1.rarity, a.outcome.parent2.rarity) - Math.max(b.outcome.parent1.rarity, b.outcome.parent2.rarity) ||
    a.outcome.parent1.rarity + a.outcome.parent2.rarity - b.outcome.parent1.rarity - b.outcome.parent2.rarity ||
    a.outcome.parent1.name.localeCompare(b.outcome.parent1.name) || a.outcome.parent2.name.localeCompare(b.outcome.parent2.name);
}

function parentLabel(pal: PalKnowledge, gender: PalGender): string {
  const suffix = gender === "MALE" ? " ♂" : gender === "FEMALE" ? " ♀" : "";
  return `${pal.name}${suffix}`;
}

function pairAvailability(pair: RankedPair): number {
  const sameSpecies = pair.outcome.parent1.internalId.toLowerCase() === pair.outcome.parent2.internalId.toLowerCase();
  const match = findOwnedBreedingMatch(pair.outcome, pair.first, pair.second);
  if (match.compatible) return 3;
  if (sameSpecies) return pair.first.length >= 2 ? 2 : pair.first.length > 0 ? 1 : 0;
  if (pair.first.length > 0 && pair.second.length > 0) return 2;
  return Number(pair.first.length > 0 || pair.second.length > 0);
}

function ownershipLabel(pair: RankedPair): string {
  const label = (pals: RosterPal[]) => {
    if (!pals.length) return "not currently observed";
    const owners = [...new Set(pals.map((pal) => pal.ownerName.trim() || "Owner unavailable"))].slice(0, 3).join(", ");
    const genders = genderCounts(pals);
    return `${owners} · ♂${genders.male} ♀${genders.female}${genders.unknown ? ` ?${genders.unknown}` : ""}`;
  };
  const sameSpecies = pair.outcome.parent1.internalId.toLowerCase() === pair.outcome.parent2.internalId.toLowerCase();
  const match = findOwnedBreedingMatch(pair.outcome, pair.first, pair.second);
  if (match.compatible) {
    const firstOwner = match.first?.ownerName.trim() || "Owner unavailable";
    const secondOwner = match.second?.ownerName.trim() || "Owner unavailable";
    return `ready: ${firstOwner} ${match.first?.gender === "male" ? "♂" : "♀"} + ${secondOwner} ${match.second?.gender === "male" ? "♂" : "♀"}`;
  }
  if (sameSpecies) return pair.first.length >= 2 ? `${label(pair.first)} · no compatible pair` : `${label(pair.first)} · needs 2 instances`;
  return `${label(pair.first)} · ${label(pair.second)}`;
}
