import {
  ActionRowBuilder,
  AttachmentBuilder,
  ComponentType,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { APIEmbedField, InteractionEditReplyOptions } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { assetsFor } from "../discord/palrender.js";
import type { PalKnowledge } from "../knowledge/paldeck.js";
import { snapshotWarning } from "../snapshots/presentation.js";
import { baseCharacterId, isBossVariant, palOwnerLabel, palVariantTags } from "../pals/presentation.js";
import { exactKnowledgeFor, metadataLabel, readyKnowledge } from "./pal-toolbox.js";

const COLLECTOR_MS = 180_000;
export type DexSection = "overview" | "work" | "combat" | "breeding";

const SECTION_LABELS: Record<DexSection, string> = {
  overview: "Overview",
  work: "Work & needs",
  combat: "Combat & learnset",
  breeding: "Breeding & data coverage",
};

export function dexControlError(expectedCustomId: string, actualCustomId: string, requesterId: string, actorId: string, value?: string): string | null {
  if (actualCustomId !== expectedCustomId) return "That Paldeck control is no longer valid.";
  if (actorId !== requesterId) return "Only the person who opened this Paldeck card can change its section.";
  if (!value || !(value in SECTION_LABELS)) return "That Paldeck section is no longer valid.";
  return null;
}

function sectionRow(customId: string, current: DexSection, disabled = false): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose a Paldeck section")
      .setDisabled(disabled)
      .addOptions((Object.entries(SECTION_LABELS) as [DexSection, string][]).map(([value, label]) => ({
        label,
        value,
        default: value === current,
      }))),
  );
}

export function dexSectionFields(known: PalKnowledge, section: DexSection): APIEmbedField[] {
  const work = known.workSuitabilities.length
    ? [...known.workSuitabilities].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)).map((item) => `${item.name} ${item.level}`).join(" · ")
    : "No work suitability";
  const learnset = known.learnset.length
    ? known.learnset.map((skill) => {
        const mechanics = [skill.element, skill.power > 0 ? `${skill.power} power` : null, skill.cooldownSeconds > 0 ? `${skill.cooldownSeconds}s` : null]
          .filter(Boolean)
          .join(" · ");
        return `Lv ${skill.unlockLevel} ${skill.name}${mechanics ? ` (${mechanics})` : ""}`;
      }).join("\n")
    : "No learnset available";
  const passives = known.guaranteedPassives?.length
    ? known.guaranteedPassives.map((passive) => `${passive.name} (rank ${passive.rank}${passive.inheritable ? ", inheritable" : ", fixed"})`).join(" · ")
    : "None guaranteed";

  if (section === "work") return [
    { name: "Work suitability", value: truncate(work, 1024) },
    { name: "Needs", value: `Food ${known.foodAmount} · Stamina ${known.stamina} · Stomach ${known.maxFullStomach}` },
    { name: "Movement", value: `Walk ${known.walkSpeed} · Run ${known.runSpeed} · Ride ${known.rideSprintSpeed} · Transport ${known.transportSpeed}` },
  ];
  if (section === "combat") return [
    { name: "Elements", value: known.elements.join(" · ") || "Unknown", inline: true },
    { name: "Base scaling", value: `HP ${known.hp} · ATK ${known.attack} · DEF ${known.defense}`, inline: true },
    { name: "Guaranteed passives", value: truncate(passives, 1024) },
    { name: "Active-skill learnset", value: truncate(learnset, 1024) },
  ];
  if (section === "breeding") return [
    { name: "Breeding", value: `Power ${known.breedingPower} · Rarity ${known.rarity}`, inline: true },
    { name: "Wild profile", value: `Lv ${known.minWildLevel}–${known.maxWildLevel} · Size ${known.size} · ${known.nocturnal ? "Nocturnal" : "Diurnal"} · Value ${known.price?.toLocaleString("en-US") ?? "unknown"}`, inline: true },
    { name: "Dataset coverage", value: "Partner skills, drops, spawn coordinates, recipes, and technology unlocks are not present in the approved pinned sources." },
  ];
  return [
    { name: "Elements", value: known.elements.join(" · ") || "Unknown", inline: true },
    { name: "Base scaling", value: `HP ${known.hp} · ATK ${known.attack} · DEF ${known.defense}`, inline: true },
    { name: "Breeding", value: `Power ${known.breedingPower} · Rarity ${known.rarity}`, inline: true },
    { name: "Wild profile", value: `Lv ${known.minWildLevel}–${known.maxWildLevel} · Size ${known.size} · ${known.nocturnal ? "Nocturnal" : "Diurnal"} · Value ${known.price?.toLocaleString("en-US") ?? "unknown"}` },
  ];
}

export const dexCommand: Command = {
  helpCategory: "pals",
  data: new SlashCommandBuilder()
    .setName("dex")
    .setDescription("Palworld 1.0 details, work skills, learnset, and server ownership")
    .addStringOption((option) =>
      option.setName("pal").setDescription("Pal name or character identifier").setRequired(true).setAutocomplete(true),
    ),

  async autocomplete(interaction, ctx) {
    try {
      await readyKnowledge(ctx.knowledge);
      const focused = interaction.options.getFocused();
      const matches = ctx.knowledge.search(focused, 25).data;
      await interaction.respond(matches.map((pal) => ({
        name: truncate(`#${pal.dexNumber}${pal.isVariant ? " variant" : ""} · ${pal.name}`, 100),
        value: pal.internalId.slice(0, 100),
      })));
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const query = interaction.options.getString("pal", true);
    try {
      await readyKnowledge(ctx.knowledge);
    } catch {
      await interaction.editReply({ embeds: [baseEmbed("Pal knowledge unavailable").setDescription("The pinned Palworld 1.0 catalogue is temporarily unavailable.")] });
      return;
    }

    const known = ctx.knowledge.get(query).data;
    if (!known) {
      await interaction.editReply({ embeds: [baseEmbed("Pal not found").setDescription(`No Palworld 1.0 Pal matched **${truncate(query, 100)}**.`)] });
      return;
    }

    const snapshot = await ctx.snapshots.get();
    const matches = snapshot.pals.filter((pal) => {
      const match = exactKnowledgeFor(ctx.knowledge, pal.characterId, pal.displayName);
      return match?.internalId.toLocaleLowerCase("en-US") === known.internalId.toLocaleLowerCase("en-US");
    });
    const owners = new Set(matches.map((pal) => pal.ownerUid).filter(Boolean));
    const best = [...matches].sort((a, b) => b.level - a.level || a.instanceId.localeCompare(b.instanceId))[0];
    const bosses = matches.filter(isBossVariant).length;
    const alpha = matches.filter((pal) => pal.isAlpha).length - bosses;
    const lucky = matches.filter((pal) => pal.isLucky).length;
    const bestOwner = best ? palOwnerLabel(best, snapshot.players) : null;
    const wikiUrl = `https://palworld.wiki.gg/wiki/${encodeURIComponent(known.name.replaceAll(" ", "_"))}`;
    const warning = snapshotWarning(snapshot, ctx.config.suppressDriftNotices);
    const ownership = matches.length
      ? `**On ${ctx.config.serverLabel}:** ${matches.length} currently owned by ${owners.size} player${owners.size === 1 ? "" : "s"}\n**Highest:** Lv ${best!.level}${palVariantTags(best!)} — ${truncate(bestOwner!, 80)}\n**Rare:** ${bosses} Boss 👑 · ${Math.max(0, alpha)} Alpha ⭐ · ${lucky} Lucky 🍀`
      : `**On ${ctx.config.serverLabel}:** None currently observed`;
    let icon: Awaited<ReturnType<ReturnType<typeof assetsFor>["palIcon"]>> | null = null;
    const render = (section: DexSection): InteractionEditReplyOptions => {
      const embed = baseEmbed(`📖 #${known.dexNumber}${known.isVariant ? " variant" : ""} · ${truncate(known.name, 190)}`)
        .setURL(wikiUrl)
        .setDescription(truncate(`${warning ? `${warning}\n\n` : ""}${ownership}\n\n[Open ${known.name} on the Palworld Wiki](${wikiUrl})`, 4096))
        .addFields(dexSectionFields(known, section))
        .setFooter({ text: truncate(`${SECTION_LABELS[section]} · ${metadataLabel(ctx.knowledge)} · ID: ${known.internalId}`, 2048) });
      if (icon) embed.setThumbnail("attachment://pal-icon.png");
      return { embeds: [embed], components: [sectionRow(`dex_section:${interaction.id}`, section)] };
    };

    icon = await assetsFor(ctx.session).palIcon(known.internalId);
    let section: DexSection = "overview";
    const initial = render(section);
    if (!icon) {
      const message = await interaction.editReply(initial);
      attachCollector(message);
    } else {
      const file = new AttachmentBuilder(icon.buffer, { name: "pal-icon.png" });
      const message = await interaction.editReply({ ...initial, files: [file] });
      attachCollector(message);
    }

    function attachCollector(message: Awaited<ReturnType<typeof interaction.editReply>>): void {
      const customId = `dex_section:${interaction.id}`;
      const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: COLLECTOR_MS });
      collector.on("collect", async (select) => {
        const next = select.values[0];
        const rejection = dexControlError(customId, select.customId, interaction.user.id, select.user.id, next);
        if (rejection) {
          await select.reply({ content: rejection, ephemeral: true }).catch(() => {});
          return;
        }
        section = next as DexSection;
        await select.update(render(section)).catch(() => {});
      });
      collector.on("end", async () => {
        await interaction.editReply({ components: [sectionRow(customId, section, true)] }).catch(() => {});
      });
    }
  },
};
