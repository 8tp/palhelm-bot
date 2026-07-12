import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command, CommandHelpCategory } from "../discord/commands.js";
import { baseEmbed } from "../discord/embeds.js";

const CATEGORY_ORDER: Array<{ id: CommandHelpCategory; label: string }> = [
  { id: "server", label: "🌐 Server" },
  { id: "players", label: "👥 Players" },
  { id: "pals", label: "🐾 Pals" },
  { id: "breeding", label: "🥚 Breeding & work" },
  { id: "records", label: "🏆 Records" },
  { id: "assistant", label: "🤖 Assistant" },
  { id: "admin", label: "🛠️ Admin — needs the server-admin role" },
];

/** Build help fields directly from the registered command objects. */
export function commandHelpFields(commands: readonly Command[]) {
  const seen = new Set<string>();
  for (const command of commands) {
    const name = command.data.name;
    if (seen.has(name)) throw new Error(`Duplicate registered command: /${name}`);
    seen.add(name);
  }

  return CATEGORY_ORDER.flatMap(({ id, label }) => {
    const members = commands.filter((command) => command.helpCategory === id);
    if (members.length === 0) return [];
    return [{
      name: label,
      value: members
        .map((command) => `**/${command.data.name}** — ${command.data.description}`)
        .join("\n"),
    }];
  });
}

export function createHelpCommand(getCommands: () => readonly Command[]): Command {
  return {
    data: new SlashCommandBuilder().setName("help").setDescription("List every Palhelm bot command by category"),
    helpCategory: "assistant",

    async execute(interaction) {
      const embed = baseEmbed("🧭 Palhelm Bot — Commands")
        .setDescription(
          "Everything the bot can do. Type `/` in any channel to browse these with Discord's autocomplete.",
        )
        .addFields(commandHelpFields(getCommands()))
        .setFooter({ text: "Most commands accept a player or Pal name with autocomplete." });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  };
}
