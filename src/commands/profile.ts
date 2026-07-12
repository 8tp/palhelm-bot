import { MessageFlags, SlashCommandBuilder, type AutocompleteInteraction } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, errorEmbed, truncate } from "../discord/embeds.js";
import type { BotContext } from "../discord/commands.js";
import type { PlayerSummary } from "../types.js";

export const profileCommand: Command = {
  helpCategory: "players",
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Link your Discord account to an unclaimed Palworld player")
    .addSubcommand((subcommand) => subcommand
      .setName("link")
      .setDescription("Claim an unclaimed Palworld player")
      .addStringOption((option) => option
        .setName("player")
        .setDescription("Your Palworld player")
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("status")
      .setDescription("Show a Discord member's linked Palworld player")
      .addUserOption((option) => option
        .setName("member")
        .setDescription("Discord member; defaults to you")))
    .addSubcommand((subcommand) => subcommand
      .setName("unlink")
      .setDescription("Remove your Palworld player link")),

  async autocomplete(interaction, ctx) {
    await playerLinkAutocomplete(interaction, ctx, false);
  },

  async execute(interaction, ctx) {
    const guildId = interaction.guildId ?? ctx.config.guildId;
    const action = interaction.options.getSubcommand();
    if (action === "status") {
      const member = interaction.options.getUser("member") ?? interaction.user;
      const link = ctx.playerLinks.get(guildId, member.id);
      if (!link) {
        await interaction.reply({
          embeds: [baseEmbed("🔗 Player profile").setDescription(
            member.id === interaction.user.id
              ? "You have not linked a Palworld player yet. Use `/profile link`."
              : `**${truncate(member.globalName ?? member.username, 80)}** has not linked a Palworld player.`,
          )],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const snapshot = await ctx.snapshots.get();
      const current = snapshot.players.find((player) => player.uid === link.playerUid);
      await interaction.reply({
        embeds: [baseEmbed("🔗 Player profile")
          .setDescription(`**${truncate(member.globalName ?? member.username, 80)}** is linked to **${truncate(current?.name ?? link.playerName, 100)}**.`)
          .addFields(
            { name: "Level", value: current ? String(current.level) : "Not in current snapshot", inline: true },
            { name: "Status", value: current?.online ? "🟢 Online" : "⚫ Offline", inline: true },
            { name: "Linked", value: `<t:${Math.floor(Date.parse(link.linkedAt) / 1_000)}:R>`, inline: true },
          )],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "unlink") {
      const removed = await ctx.playerLinks.unlink(guildId, interaction.user.id);
      await interaction.reply({
        embeds: [removed
          ? baseEmbed("Player link removed").setDescription(`Your link to **${truncate(removed.playerName, 100)}** was removed.`)
          : errorEmbed("You do not currently have a linked Palworld player.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString("player", true);
    const snapshot = await ctx.snapshots.get();
    const player = resolveCurrentPlayer(snapshot.players, query);
    if (!player) {
      await interaction.reply({ embeds: [errorEmbed("That player is not in the current Palhelm snapshot.")], flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const link = await ctx.playerLinks.claim({
        guildId,
        discordUserId: interaction.user.id,
        playerUid: player.uid,
        playerName: player.name,
      });
      await interaction.reply({
        embeds: [baseEmbed("🔗 Player linked").setDescription(
          `You are now linked to **${truncate(link.playerName, 100)}**. The AI guide can use your complete roster for first-person questions.`,
        )],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        embeds: [errorEmbed(error instanceof Error && error.message === "player_claimed"
          ? "That Palworld player is already linked to another Discord member. Ask an admin to reassign it if needed."
          : "The player link could not be saved safely.")],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

export const profileAdminCommand: Command = {
  helpCategory: "admin",
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("profileadmin")
    .setDescription("Reassign or clear Discord-to-Palworld player links")
    .addSubcommand((subcommand) => subcommand
      .setName("assign")
      .setDescription("Assign a Palworld player, replacing conflicting links")
      .addUserOption((option) => option.setName("member").setDescription("Discord member").setRequired(true))
      .addStringOption((option) => option
        .setName("player")
        .setDescription("Palworld player")
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("clear")
      .setDescription("Clear a Discord member's player link")
      .addUserOption((option) => option.setName("member").setDescription("Discord member").setRequired(true))),

  async autocomplete(interaction, ctx) {
    await playerLinkAutocomplete(interaction, ctx, true);
  },

  async execute(interaction, ctx) {
    const guildId = interaction.guildId ?? ctx.config.guildId;
    const action = interaction.options.getSubcommand();
    const member = interaction.options.getUser("member", true);
    if (action === "clear") {
      const removed = await ctx.playerLinks.unlink(guildId, member.id);
      await interaction.reply({
        embeds: [removed
          ? baseEmbed("Player link cleared").setDescription(`Cleared **${truncate(member.globalName ?? member.username, 80)}** → **${truncate(removed.playerName, 100)}**.`)
          : errorEmbed("That Discord member does not have a player link.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const query = interaction.options.getString("player", true);
    const snapshot = await ctx.snapshots.get();
    const player = resolveCurrentPlayer(snapshot.players, query);
    if (!player) {
      await interaction.reply({ embeds: [errorEmbed("That player is not in the current Palhelm snapshot.")], flags: MessageFlags.Ephemeral });
      return;
    }
    const link = await ctx.playerLinks.assign({
      guildId,
      discordUserId: member.id,
      playerUid: player.uid,
      playerName: player.name,
      linkedBy: interaction.user.id,
    });
    await interaction.reply({
      embeds: [baseEmbed("Player link assigned").setDescription(
        `**${truncate(member.globalName ?? member.username, 80)}** is now linked to **${truncate(link.playerName, 100)}**. Any conflicting link was replaced.`,
      )],
      flags: MessageFlags.Ephemeral,
    });
  },
};

async function playerLinkAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: BotContext,
  includeClaimed: boolean,
): Promise<void> {
  try {
    if (interaction.options.getSubcommand() !== "link" && interaction.options.getSubcommand() !== "assign") {
      await interaction.respond([]);
      return;
    }
    const guildId = interaction.guildId ?? ctx.config.guildId;
    const focused = interaction.options.getFocused().toLocaleLowerCase("en-US");
    const currentLink = ctx.playerLinks.get(guildId, interaction.user.id);
    const snapshot = await ctx.snapshots.get();
    const choices = snapshot.players
      .filter((player) => player.name.toLocaleLowerCase("en-US").includes(focused))
      .filter((player) => includeClaimed || !ctx.playerLinks.getByPlayer(guildId, player.uid) || currentLink?.playerUid === player.uid)
      .slice(0, 25)
      .map((player) => {
        const claimant = ctx.playerLinks.getByPlayer(guildId, player.uid);
        const suffix = claimant && includeClaimed ? " · currently linked" : player.online ? " · online" : "";
        return { name: truncate(`${player.name}${suffix}`, 100), value: player.uid.slice(0, 100) };
      });
    await interaction.respond(choices);
  } catch {
    await interaction.respond([]);
  }
}

function resolveCurrentPlayer(players: PlayerSummary[], query: string): PlayerSummary | undefined {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  return players.find((player) => player.uid === query.trim()) ??
    players.find((player) => player.name.toLocaleLowerCase("en-US") === normalized);
}
