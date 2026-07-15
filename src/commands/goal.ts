import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, errorEmbed, truncate } from "../discord/embeds.js";
import type { GoalVariant } from "../goals/service.js";
import { baseCharacterId } from "../pals/presentation.js";
import type { BreedingOutcome } from "../knowledge/paldeck.js";
import type { WorldSnapshot } from "../snapshots/service.js";

const VARIANT_LABELS: Record<GoalVariant, string> = {
  any: "Any",
  alpha: "Alpha ⭐",
  lucky: "Lucky 🍀",
  boss: "Boss 👑",
};

export const goalCommand: Command = {
  helpCategory: "breeding",
  data: new SlashCommandBuilder()
    .setName("goal")
    .setDescription("Track a Pal collection or breeding goal")
    .addSubcommand((subcommand) => subcommand
      .setName("add")
      .setDescription("Track a new Pal goal")
      .addStringOption((option) => option
        .setName("pal")
        .setDescription("Pal name or species ID")
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption((option) => option
        .setName("variant")
        .setDescription("Optional rare variant")
        .addChoices(
          { name: "Any", value: "any" },
          { name: "Alpha", value: "alpha" },
          { name: "Lucky", value: "lucky" },
          { name: "Boss", value: "boss" },
        )))
    .addSubcommand((subcommand) => subcommand
      .setName("list")
      .setDescription("List your active Pal goals"))
    .addSubcommand((subcommand) => subcommand
      .setName("remove")
      .setDescription("Remove one of your active goals")
      .addStringOption((option) => option
        .setName("id")
        .setDescription("Goal ID shown by /goal list")
        .setRequired(true)
        .setMaxLength(20))),

  async autocomplete(interaction, ctx) {
    try {
      if (interaction.options.getSubcommand() !== "add") return await interaction.respond([]);
      const query = interaction.options.getFocused();
      await ctx.knowledge.init();
      const matches = ctx.knowledge.search(query, 25).data;
      await interaction.respond(matches.map((pal) => ({
        name: truncate(`${pal.name} · ${pal.internalId}`, 100),
        value: pal.internalId.slice(0, 100),
      })));
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const action = interaction.options.getSubcommand();
    if (action === "list") {
      const goals = ctx.goals.list(interaction.user.id);
      const lines = goals.map((goal) =>
        `**#${goal.id}** ${goal.speciesName} · ${VARIANT_LABELS[goal.variant]}${goal.breedingPlan ? ` · 🧬 ${goal.breedingPlan.steps.length} step${goal.breedingPlan.steps.length === 1 ? "" : "s"}${goal.breedingPlan.passive ? ` · ${truncate(goal.breedingPlan.passive, 50)}` : ""}` : ""} · since <t:${Math.floor(Date.parse(goal.createdAt) / 1_000)}:R>`,
      );
      await interaction.editReply({
        embeds: [baseEmbed("🎯 Your Pal Goals").setDescription(
          lines.length > 0 ? truncate(lines.join("\n"), 4096) : "You have no active goals. Use `/goal add` to create one.",
        )],
      });
      return;
    }
    if (action === "remove") {
      const id = interaction.options.getString("id", true).trim();
      const removed = await ctx.goals.remove(id, interaction.user.id);
      await interaction.editReply({
        embeds: [removed
          ? baseEmbed("Goal removed").setDescription(`Removed goal **#${truncate(id, 20)}**.`)
          : errorEmbed("That active goal ID does not belong to you.")],
      });
      return;
    }

    const query = interaction.options.getString("pal", true);
    const variant = (interaction.options.getString("variant") ?? "any") as GoalVariant;
    await ctx.knowledge.init();
    const known = ctx.knowledge.get(query).data;
    if (!known) {
      await interaction.editReply({ embeds: [errorEmbed("No Palworld 1.0 species matched that name or ID.")] });
      return;
    }
    const snapshot = await ctx.snapshots.get();
    try {
      const goal = await ctx.goals.add({
        createdBy: interaction.user.id,
        createdByName: interaction.user.globalName ?? interaction.user.username,
        speciesId: known.internalId,
        speciesName: known.name,
        variant,
        snapshot,
      });
      const suggestions = breedingSuggestions(ctx.knowledge.parentsFor(known.internalId, 100).data, snapshot);
      const body = [
        `Tracking **${VARIANT_LABELS[variant]} ${known.name}** as goal **#${goal.id}**.`,
        "I’ll post when a newly observed matching Pal appears.",
        ...(suggestions.length > 0 ? ["", "**Closest breeding pairs from the current roster**", ...suggestions] : []),
      ].join("\n");
      await interaction.editReply({ embeds: [baseEmbed("🎯 Goal added").setDescription(truncate(body, 4096))] });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const message = code === "already_observed"
        ? `A matching ${known.name} is already observed in the current save.`
        : code === "duplicate_goal"
          ? "You already have that exact Pal goal."
          : code === "user_goal_limit"
            ? "You already have the maximum of 10 active goals."
            : code === "goal_limit"
              ? "The server already has the maximum of 50 active goals."
              : "The goal could not be saved safely.";
      await interaction.editReply({ embeds: [errorEmbed(message)] });
    }
  },
};

function breedingSuggestions(outcomes: BreedingOutcome[], snapshot: WorldSnapshot): string[] {
  const counts = new Map<string, number>();
  for (const pal of snapshot.pals) {
    const key = baseCharacterId(pal.characterId).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return outcomes.map((pair) => {
    const a = counts.get(pair.parent1.internalId.toLowerCase()) ?? 0;
    const b = counts.get(pair.parent2.internalId.toLowerCase()) ?? 0;
    const same = pair.parent1.internalId.toLowerCase() === pair.parent2.internalId.toLowerCase();
    const missing = same ? Math.max(0, 2 - a) : (a > 0 ? 0 : 1) + (b > 0 ? 0 : 1);
    return { pair, a, b, missing, rarity: pair.parent1.rarity + pair.parent2.rarity };
  }).sort((x, y) => x.missing - y.missing || x.rarity - y.rarity)
    .slice(0, 3)
    .map(({ pair, a, b, missing }) =>
      `${missing === 0 ? "✅" : "◻️"} ${pair.parent1.name} (${a}) + ${pair.parent2.name} (${b})${missing > 0 ? ` · missing ${missing}` : " · ready"}`,
    );
}
