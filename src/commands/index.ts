// Central command registry. Each command lives in its own module; agents
// implementing a command edit only their own file, never this one.
import type { Command } from "../discord/commands.js";
import { statusCommand } from "./status.js";
import { playersCommand } from "./players.js";
import { playerCommand } from "./player.js";
import { guildsCommand } from "./guilds.js";
import { metricsCommand } from "./metrics.js";
import { mapCommand } from "./map.js";
import { palsCommand } from "./pals.js";
import { boxCommand } from "./box.js";
import { backupCommand } from "./backup.js";
import { backupsCommand } from "./backups.js";
import { announceCommand } from "./announce.js";
import { leaderboardCommand } from "./leaderboard.js";
import { compareCommand } from "./compare.js";
import { whohasCommand } from "./whohas.js";
import { recordsCommand } from "./records.js";
import { collectionCommand } from "./collection.js";
import { dexCommand } from "./dex.js";
import { askCommand } from "./ask.js";
import { goalCommand } from "./goal.js";
import { breedCommand } from "./breed.js";
import { workersCommand } from "./workers.js";
import { rareCommand } from "./rare.js";
import { teamCommand } from "./team.js";
import { progressCommand } from "./progress.js";
import { trendsCommand } from "./trends.js";
import { breedpathCommand } from "./breedpath.js";
import { historyCommand } from "./history.js";
import { createHelpCommand } from "./help.js";
import { diagnosticsCommand } from "./diagnostics.js";
import { profileAdminCommand, profileCommand } from "./profile.js";
import { palCommand } from "./pal.js";

const featureCommands: Command[] = [
  statusCommand,
  playersCommand,
  playerCommand,
  guildsCommand,
  metricsCommand,
  mapCommand,
  palsCommand,
  boxCommand,
  backupCommand,
  backupsCommand,
  announceCommand,
  leaderboardCommand,
  compareCommand,
  whohasCommand,
  recordsCommand,
  collectionCommand,
  dexCommand,
  breedCommand,
  workersCommand,
  askCommand,
  goalCommand,
  rareCommand,
  teamCommand,
  progressCommand,
  trendsCommand,
  breedpathCommand,
  historyCommand,
  diagnosticsCommand,
  profileCommand,
  profileAdminCommand,
  palCommand,
];

/** The one registry used by Discord dispatch, registration, and /help. */
export const commands: Command[] = [...featureCommands];
commands.push(createHelpCommand(() => commands));
