import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { baseCharacterId } from "../pals/presentation.js";
import { exactKnowledgeFor, metadataLabel, readyKnowledge } from "./pal-toolbox.js";
import type { BreedingStep } from "../knowledge/paldeck.js";
import type { RosterPal } from "../types.js";
import type { PlayerSummary } from "../types.js";
import { findOwnedBreedingMatch, genderCounts } from "../breeding/owned.js";
import { humanizeInternalName } from "../pals/names.js";

const MAX_STEPS = 14;

export const breedpathCommand: Command = {
  helpCategory: "breeding",
  data: new SlashCommandBuilder()
    .setName("breedpath")
    .setDescription("Find the shortest breeding chain from your linked Palworld roster")
    .addStringOption((option) =>
      option.setName("target").setDescription("Desired Pal").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName("scope").setDescription("Whose roster to use; defaults to your linked profile").setRequired(false)
        .addChoices(
          { name: "My linked profile", value: "mine" },
          { name: "Everyone on the server", value: "server" },
        ),
    )
    .addStringOption((option) =>
      option.setName("player").setDescription("Optional specific player override").setRequired(false).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName("passive").setDescription("Optional desired passive/trait to preserve").setRequired(false).setMaxLength(100),
    )
    .addBooleanOption((option) =>
      option.setName("track").setDescription("Save this plan as a personal /goal").setRequired(false),
    ),

  async autocomplete(interaction, ctx) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name === "player") {
        const snapshot = await ctx.snapshots.get();
        const query = String(focused.value).toLowerCase();
        await interaction.respond(
          snapshot.players
            .filter((player) => player.name.toLowerCase().includes(query))
            .slice(0, 25)
            .map((player) => ({ name: player.name.slice(0, 100), value: player.uid })),
        );
        return;
      }
      await readyKnowledge(ctx.knowledge);
      await interaction.respond(
        ctx.knowledge.search(String(focused.value), 25).data.map((pal) => ({
          name: truncate(`#${pal.dexNumber}${pal.isVariant ? " variant" : ""} · ${pal.name}`, 100),
          value: pal.internalId.slice(0, 100),
        })),
      );
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
    const targetQuery = interaction.options.getString("target", true);
    const requestedScope = interaction.options.getString("scope");
    const playerQuery = interaction.options.getString("player");
    const passiveQuery = interaction.options.getString("passive");
    const track = interaction.options.getBoolean("track") ?? false;
    const snapshot = await ctx.snapshots.get();
    const guildId = interaction.guildId ?? ctx.config.guildId;
    const linkedPlayerUid = !playerQuery && requestedScope !== "server"
      ? ctx.playerLinks.get(guildId, interaction.user.id)?.playerUid ?? null
      : null;
    const selection = selectBreedpathScope(snapshot.players, playerQuery, requestedScope, linkedPlayerUid);
    if (selection.kind === "unlinked") {
      await interaction.editReply({ embeds: [baseEmbed("Link your Palworld profile").setDescription(
        "`/breedpath` uses your own Pals by default. Use `/profile link` to connect your Discord account, or choose **Everyone on the server** in the `scope` option.",
      )] });
      return;
    }
    if (selection.kind === "linked_player_missing") {
      await interaction.editReply({ embeds: [baseEmbed("Linked player unavailable").setDescription(
        "Your linked Palworld player is not present in the current panel snapshot. Use `/profile status` to check the link or `/profile link` to update it.",
      )] });
      return;
    }
    if (selection.kind === "player_not_found") {
      await interaction.editReply({ embeds: [baseEmbed("Player not found").setDescription(`No current player matching **${truncate(playerQuery ?? "", 100)}**.`)] });
      return;
    }
    const player = selection.kind === "player" ? selection.player : null;

    // Currently owned species, resolved to canonical pinned internal IDs so the
    // graph search joins against the same identifiers it breeds over.
    const owned = new Set<string>();
    const ownedPals = new Map<string, RosterPal[]>();
    for (const pal of snapshot.pals) {
      if (player && pal.ownerUid !== player.uid) continue;
      const known = exactKnowledgeFor(ctx.knowledge, pal.characterId, pal.displayName);
      const speciesId = (known?.internalId ?? baseCharacterId(pal.characterId)).toLowerCase();
      owned.add(speciesId);
      ownedPals.set(speciesId, [...(ownedPals.get(speciesId) ?? []), pal]);
    }

    const path = ctx.knowledge.breedingPath(targetQuery, owned).data;
    if (!path) {
      await interaction.editReply({ embeds: [baseEmbed("Pal not found").setDescription(`No Palworld 1.0 Pal matched **${truncate(targetQuery, 100)}**.`)] });
      return;
    }
    const scope = player
      ? `${player.name}'s current roster${playerQuery ? "" : " (your linked profile)"}`
      : `the current rosters on ${ctx.config.serverLabel}`;
    const embed = baseEmbed(`🧬 Breeding path · ${truncate(path.target.name, 200)}`);

    if (path.alreadyOwned) {
      embed.setDescription(`**${path.target.name}** is already present in ${scope}. Use \`/whohas ${path.target.name}\` to find it, or \`/breed ${path.target.name}\` to make more.`);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    if (!path.reachable || path.steps.length === 0) {
      embed.setDescription(`No breeding chain to **${path.target.name}** exists from ${scope}. You'll need to catch a new parent species first — try \`/breed ${path.target.name}\` to see which direct parents to hunt.`);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const shown = path.steps.slice(0, MAX_STEPS);
    const lines = shown.map((step, index) => {
      const p1 = `${step.parent1Owned ? "✅" : "🥚"} ${step.parent1.name}`;
      const p2 = `${step.parent2Owned ? "✅" : "🥚"} ${step.parent2.name}`;
      return `**${index + 1}.** ${p1} + ${p2} → **${step.child.name}**`;
    });
    if (path.steps.length > shown.length) lines.push(`…and ${path.steps.length - shown.length} more steps`);
    const feasibility = breedingFeasibilityNotes(path.steps, ownedPals);
    const passive = passivePlanNote(passiveQuery, [...ownedPals.values()].flat());
    let goalLine = "";
    if (track) {
      try {
        const goal = await ctx.goals.add({
          createdBy: interaction.user.id,
          createdByName: interaction.user.globalName ?? interaction.user.username,
          speciesId: path.target.internalId,
          speciesName: path.target.name,
          variant: "any",
          snapshot,
          ...(player ? { ownerUid: player.uid } : {}),
          breedingPlan: {
            ...(passiveQuery?.trim() ? { passive: passiveQuery.trim() } : {}),
            steps: path.steps.map((step) => ({ parent1: step.parent1.name, parent2: step.parent2.name, child: step.child.name })),
          },
        });
        goalLine = `\n\n🎯 Saved as goal **#${goal.id}**${player ? ` for ${player.name}'s roster` : ""}. Use \`/goal list\` to resume it.`;
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        goalLine = `\n\n⚠️ Plan not saved: ${code === "duplicate_goal" ? "that target is already in your goals" : code === "user_goal_limit" ? "you already have 10 active goals" : "the goal could not be saved safely"}.`;
      }
    }

    embed.setDescription(truncate(
      `Shortest chain from ${scope} — **${path.steps.length} breeding step${path.steps.length === 1 ? "" : "s"}**.\n✅ owned now · 🥚 bred in an earlier step\n\n${lines.join("\n")}${passive ? `\n\n🧬 **Desired passive**\n${passive}` : ""}${feasibility.length ? `\n\n⚠️ **Feasibility notes**\n${feasibility.join("\n")}` : ""}${goalLine}`,
      4096,
    ));
    embed.setFooter({ text: truncate(`${metadataLabel(ctx.knowledge)} · observed parent genders checked; intermediate offspring gender and passive inheritance are not guaranteed`, 2048) });
    await interaction.editReply({ embeds: [embed] });
  },
};

export type BreedpathScopeSelection =
  | { kind: "server" }
  | { kind: "player"; player: PlayerSummary }
  | { kind: "unlinked" }
  | { kind: "linked_player_missing" }
  | { kind: "player_not_found" };

/** Resolve roster scope without ever falling back from an unlinked profile to server-wide data. */
export function selectBreedpathScope(
  players: readonly PlayerSummary[],
  explicitPlayerQuery: string | null,
  requestedScope: string | null,
  linkedPlayerUid: string | null,
): BreedpathScopeSelection {
  if (explicitPlayerQuery) {
    const query = explicitPlayerQuery.trim();
    const player = players.find((item) => item.uid === query) ??
      players.find((item) => item.name.toLocaleLowerCase("en-US") === query.toLocaleLowerCase("en-US"));
    return player ? { kind: "player", player } : { kind: "player_not_found" };
  }
  if (requestedScope === "server") return { kind: "server" };
  if (!linkedPlayerUid) return { kind: "unlinked" };
  const player = players.find((item) => item.uid === linkedPlayerUid);
  return player ? { kind: "player", player } : { kind: "linked_player_missing" };
}

export function passivePlanNote(query: string | null, pals: readonly RosterPal[]): string | null {
  const needle = query?.trim().toLocaleLowerCase("en-US");
  if (!needle) return null;
  const carriers = pals.filter((pal) => (pal.passiveSkillIds ?? []).some((id) =>
    id.toLocaleLowerCase("en-US").includes(needle) || humanizeInternalName(id).toLocaleLowerCase("en-US").includes(needle)
  ));
  if (carriers.length === 0) {
    return `No observed scoped Pal carries **${truncate(query!.trim(), 80)}**. This species chain does not establish passive inheritance.`;
  }
  const shown = carriers.slice(0, 6).map((pal) => `${pal.displayName} ${pal.gender === "male" ? "♂" : pal.gender === "female" ? "♀" : "?"}`).join(" · ");
  return `${carriers.length} observed carrier${carriers.length === 1 ? "" : "s"}: ${truncate(shown, 500)}${carriers.length > 6 ? ` · +${carriers.length - 6} more` : ""}. Prefer routes using a carrier, but egg inheritance is chance-based and not guaranteed.`;
}

export function breedingFeasibilityNotes(
  steps: readonly BreedingStep[],
  ownedPals: ReadonlyMap<string, readonly RosterPal[]>,
): string[] {
  const notes = new Set<string>();
  for (const step of steps) {
    const parent1 = step.parent1.internalId.toLowerCase();
    const parent2 = step.parent2.internalId.toLowerCase();
    if (step.parent1Owned && step.parent2Owned) {
      const first = ownedPals.get(parent1) ?? [];
      const second = ownedPals.get(parent2) ?? [];
      const match = findOwnedBreedingMatch(step, first, second);
      if (!match.compatible) {
        const counts = genderCounts(parent1 === parent2 ? first : [...first, ...second]);
        notes.add(`• **${step.parent1.name} + ${step.parent2.name}** has no observed compatible ♂+♀ pair (♂${counts.male} · ♀${counts.female}${counts.unknown ? ` · ?${counts.unknown}` : ""}).`);
      }
    } else {
      notes.add("• An intermediate egg may need to be bred again if it hatches with the wrong gender for a later step.");
    }
  }
  if (steps.some((step) => step.parent1Owned || step.parent2Owned)) {
    notes.add("• Compatible gender does not guarantee desired passive or talent inheritance.");
  }
  return [...notes];
}
