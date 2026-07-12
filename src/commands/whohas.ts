import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import type { RosterPal } from "../types.js";
import { snapshotWarning } from "../snapshots/presentation.js";
import { baseCharacterId, isBossVariant, palOwnerLabel } from "../pals/presentation.js";

const MAX_OWNERS = 20;
interface OwnerGroup {
  uid: string;
  name: string;
  pals: RosterPal[];
}

export const whohasCommand: Command = {
  helpCategory: "pals",
  data: new SlashCommandBuilder()
    .setName("whohas")
    .setDescription("Find the current owners of a Pal species")
    .addStringOption((option) =>
      option
        .setName("pal")
        .setDescription("Pal name or character identifier")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction, ctx) {
    try {
      const focused = interaction.options.getFocused().toLowerCase();
      const snapshot = await ctx.snapshots.get();
      const species = new Map<string, { id: string; name: string }>();
      for (const pal of snapshot.pals) {
        const id = baseCharacterId(pal.characterId);
        const key = id.toLowerCase();
        if (!species.has(key)) species.set(key, { id, name: pal.displayName });
      }
      const choices = [...species.values()]
        .filter(
          (pal) =>
            pal.name.toLowerCase().includes(focused) || pal.id.toLowerCase().includes(focused),
        )
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 25)
        .map((pal) => ({
          name: truncate(`${pal.name} · ${pal.id}`, 100),
          value: pal.id.slice(0, 100),
        }));
      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const query = interaction.options.getString("pal", true);
    const snapshot = await ctx.snapshots.get();
    const exact = snapshot.pals.filter(
      (pal) =>
        baseCharacterId(pal.characterId).toLowerCase() === baseCharacterId(query).toLowerCase() ||
        pal.displayName.toLowerCase() === query.toLowerCase(),
    );

    if (exact.length === 0) {
      await interaction.editReply({
        embeds: [
          baseEmbed("Pal not found").setDescription(
            `No currently owned Pal matching **${truncate(query, 100)}**. Try choosing an observed species from autocomplete.`,
          ),
        ],
      });
      return;
    }

    const groups = new Map<string, OwnerGroup>();
    for (const pal of exact) {
      const group = groups.get(pal.ownerUid) ?? {
        uid: pal.ownerUid,
        name: palOwnerLabel(pal, snapshot.players),
        pals: [],
      };
      group.pals.push(pal);
      groups.set(pal.ownerUid, group);
    }
    const owners = [...groups.values()].sort(
      (a, b) =>
        b.pals.length - a.pals.length ||
        Math.max(...b.pals.map((pal) => pal.level)) - Math.max(...a.pals.map((pal) => pal.level)) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.uid.localeCompare(b.uid),
    );
    const lines = owners.slice(0, MAX_OWNERS).map((owner) => {
      const best = Math.max(...owner.pals.map((pal) => pal.level));
      const alpha = owner.pals.some(isBossVariant)
        ? " 👑"
        : owner.pals.some((pal) => pal.isAlpha) ? " ⭐" : "";
      const lucky = owner.pals.some((pal) => pal.isLucky) ? " 🍀" : "";
      const party = owner.pals.filter((pal) => pal.inParty).length;
      return `**${truncate(owner.name, 70)}** — ${owner.pals.length} · best Lv ${best}${alpha}${lucky}${party > 0 ? ` · ${party} in party` : ""}`;
    });
    if (owners.length > MAX_OWNERS) lines.push(`…and ${owners.length - MAX_OWNERS} more owners`);

    const name = exact[0]?.displayName ?? query;
    const summary = `${exact.length} currently owned across ${owners.length} player${owners.length === 1 ? "" : "s"}`;
    const body = `${summary}\n\n${lines.join("\n")}`;
    const warning = snapshotWarning(snapshot, ctx.config.suppressDriftNotices);
    const embed = baseEmbed(`🔎 Who has ${truncate(name, 220)}?`)
      .setDescription(warning ? `${warning}\n\n${body}` : body)
      .setFooter({ text: `Snapshot ${new Date(snapshot.capturedAt).toUTCString()}` });

    await interaction.editReply({ embeds: [embed] });
  },
};
