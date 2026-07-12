import { AttachmentBuilder, SlashCommandBuilder, type APIEmbedField } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { assetsFor } from "../discord/palrender.js";
import type { PalKnowledge } from "../knowledge/paldeck.js";
import { palOwnerLabel, palVariantTags } from "../pals/presentation.js";
import { humanizeInternalName } from "../pals/names.js";
import type { RosterPal } from "../types.js";
import { exactKnowledgeFor, metadataLabel, readyKnowledge } from "./pal-toolbox.js";

export const palCommand: Command = {
  helpCategory: "pals",
  data: new SlashCommandBuilder()
    .setName("pal")
    .setDescription("Inspect one owned Pal instance with work, stats, skills, and placement")
    .addStringOption((option) => option
      .setName("pal")
      .setDescription("Owned Pal instance")
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName("player")
      .setDescription("Optional player roster; your linked player is preferred")
      .setAutocomplete(true)),

  async autocomplete(interaction, ctx) {
    try {
      const focusedName = interaction.options.getFocused(true).name;
      const focused = String(interaction.options.getFocused()).toLocaleLowerCase("en-US");
      const snapshot = await ctx.snapshots.get();
      if (focusedName === "player") {
        await interaction.respond(snapshot.players
          .filter((player) => player.name.toLocaleLowerCase("en-US").includes(focused))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 25)
          .map((player) => ({ name: player.name.slice(0, 100), value: player.uid })));
        return;
      }
      const guildId = interaction.guildId ?? ctx.config.guildId;
      const explicitPlayer = interaction.options.getString("player");
      const linkedUid = ctx.playerLinks.get(guildId, interaction.user.id)?.playerUid;
      const playerUid = explicitPlayer || linkedUid;
      const pals = snapshot.pals
        .filter((pal) => !playerUid || pal.ownerUid === playerUid)
        .filter((pal) => pal.displayName.toLocaleLowerCase("en-US").includes(focused) || pal.characterId.toLocaleLowerCase("en-US").includes(focused))
        .sort((a, b) => b.level - a.level || a.displayName.localeCompare(b.displayName) || a.instanceId.localeCompare(b.instanceId))
        .slice(0, 25);
      await interaction.respond(pals.map((pal) => ({
        name: truncate(`Lv ${pal.level} ${pal.displayName}${palVariantTags(pal)} · ${placementLabel(pal)} · ${palOwnerLabel(pal, snapshot.players)}`, 100),
        value: pal.instanceId.slice(0, 100),
      })));
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    await readyKnowledge(ctx.knowledge);
    const snapshot = await ctx.snapshots.get();
    const query = interaction.options.getString("pal", true);
    const playerQuery = interaction.options.getString("player");
    const guildId = interaction.guildId ?? ctx.config.guildId;
    const linkedUid = ctx.playerLinks.get(guildId, interaction.user.id)?.playerUid;
    const requestedPlayer = playerQuery
      ? snapshot.players.find((player) => player.uid === playerQuery) ?? snapshot.players.find((player) => player.name.toLocaleLowerCase("en-US") === playerQuery.toLocaleLowerCase("en-US"))
      : linkedUid ? snapshot.players.find((player) => player.uid === linkedUid) : undefined;
    if (playerQuery && !requestedPlayer) {
      await interaction.editReply({ embeds: [baseEmbed("Player not found").setDescription("No current player matched that name or UID.")] });
      return;
    }
    const scoped = snapshot.pals.filter((pal) => !requestedPlayer || pal.ownerUid === requestedPlayer.uid);
    const normalized = query.toLocaleLowerCase("en-US");
    const pal = scoped.find((candidate) => candidate.instanceId === query) ?? scoped
      .filter((candidate) => candidate.displayName.toLocaleLowerCase("en-US") === normalized || candidate.characterId.toLocaleLowerCase("en-US") === normalized)
      .sort((a, b) => b.level - a.level || a.instanceId.localeCompare(b.instanceId))[0];
    if (!pal) {
      await interaction.editReply({ embeds: [baseEmbed("Pal not found").setDescription("No owned Pal instance matched that selection in the requested roster.")] });
      return;
    }
    const known = exactKnowledgeFor(ctx.knowledge, pal.characterId, pal.displayName);
    if (!known) {
      await interaction.editReply({ embeds: [baseEmbed(`🐾 ${truncate(pal.displayName, 220)}`).addFields(instanceFields(pal, null, palOwnerLabel(pal, snapshot.players)))] });
      return;
    }
    const owner = palOwnerLabel(pal, snapshot.players);
    const embed = baseEmbed(`🐾 Lv ${pal.level} ${truncate(known.name, 190)}${palVariantTags(pal)}`)
      .setDescription(`Owned by **${truncate(owner, 100)}** · ${placementLabel(pal)}`)
      .addFields(instanceFields(pal, known, owner))
      .setFooter({ text: truncate(`${metadataLabel(ctx.knowledge)} · instance ${pal.instanceId}`, 2048) });
    const icon = await assetsFor(ctx.session).palIcon(known.internalId);
    if (icon) {
      embed.setThumbnail("attachment://pal-icon.png");
      await interaction.editReply({ embeds: [embed], files: [new AttachmentBuilder(icon.buffer, { name: "pal-icon.png" })] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
  },
};

export function instanceFields(pal: RosterPal, known: PalKnowledge | null, owner: string): APIEmbedField[] {
  const fields: APIEmbedField[] = [
    { name: "Instance", value: `Level ${pal.level} · ${placementLabel(pal)}\nOwner: ${truncate(owner, 90)}` },
  ];
  if (known) {
    const work = [...known.workSuitabilities]
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))
      .map((item) => `${item.name} **${item.level}**`)
      .join(" · ") || "No work suitability";
    const learned = known.learnset
      .filter((skill) => skill.unlockLevel <= pal.level)
      .sort((a, b) => b.unlockLevel - a.unlockLevel)
      .slice(0, 8)
      .map((skill) => `${skill.name} (${skill.element ?? "Neutral"} · ${skill.power} power)`)
      .join("\n") || "No level-learned skills in the pinned dataset";
    fields.push(
      { name: "Work suitability · species data", value: truncate(work, 1024) },
      { name: "Base scaling · species data", value: `HP ${known.hp} · ATK ${known.attack} · DEF ${known.defense} · ${known.elements.join("/") || "Unknown element"}` },
      { name: `Learnset through Lv ${pal.level} · not equipped skills`, value: truncate(learned, 1024) },
    );
  }
  if (pal.hp !== undefined || pal.gender || pal.talents || pal.passiveSkillIds?.length || pal.equippedSkillIds?.length) {
    fields.push({
      name: "Individual save data",
      value: truncate([
        pal.gender ? `Gender: ${pal.gender}` : null,
        pal.hp === undefined ? null : `Current HP: ${pal.hp}`,
        pal.talents ? `Talents: HP ${pal.talents.hp ?? "?"} · Melee ${pal.talents.melee ?? "?"} · Shot ${pal.talents.shot ?? "?"} · DEF ${pal.talents.defense ?? "?"}` : null,
        pal.passiveSkillIds?.length ? `Passives: ${pal.passiveSkillIds.map(humanizeInternalName).join(", ")}` : null,
        pal.equippedSkillIds?.length ? `Equipped: ${pal.equippedSkillIds.map(humanizeInternalName).join(", ")}` : null,
      ].filter(Boolean).join("\n"), 1024),
    });
  } else {
    fields.push({ name: "Individual save data", value: "Passives, equipped attacks, gender, HP, and talents require the pending panel contract rollout." });
  }
  return fields;
}

function placementLabel(pal: RosterPal): string {
  if (pal.placement === "base" && pal.baseId) return `Base worker · ${pal.baseId.slice(0, 8)}`;
  if (pal.inParty) return `Party slot ${(pal.partySlot ?? 0) + 1}`;
  if (pal.boxPage !== undefined && pal.boxPage !== null) return `Box ${pal.boxPage + 1}, slot ${(pal.boxSlot ?? 0) + 1}`;
  return "Stored/deployed outside a personal box";
}
