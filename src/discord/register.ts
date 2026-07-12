// One-shot slash-command registration (guild-scoped: updates appear instantly).
// Run with: npm run register
import { REST, Routes } from "discord.js";
import { loadConfig } from "../config.js";
import { commands } from "../commands/index.js";

const config = loadConfig();
const rest = new REST().setToken(config.discordToken);

const body = commands.map((c) => c.data.toJSON());
await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
  body,
});
// Do not echo configuration values (including the guild id) into CI or service logs.
console.log(`Registered ${body.length} guild-scoped slash commands:`);
for (const c of body) console.log(`  /${c.name} — ${"description" in c ? c.description : ""}`);
