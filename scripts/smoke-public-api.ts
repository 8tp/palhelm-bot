/**
 * Read-only post-deploy smoke check for Palhelm's public Integration API.
 * Prints counts and availability only: never player data, URLs, keys, or bodies.
 */
import "dotenv/config";
import { IntegrationClient } from "../src/palhelm/integration.js";

const baseUrl = required("PALHELM_BASE_URL").replace(/\/+$/, "");
const key = required("PALHELM_INTEGRATION_KEY");
const client = new IntegrationClient(baseUrl, key);

const [players, pals, guilds, server, metrics] = await Promise.all([
  client.players(),
  client.pals(),
  client.guilds(),
  client.server(),
  client.metricsCurrent(),
]);

for (const player of players.data) {
  optionalNonNegative(player.captureTotal, "players.captureTotal");
  optionalNonNegative(player.uniquePalsCaptured, "players.uniquePalsCaptured");
  optionalNonNegative(player.paldeckUnlocked, "players.paldeckUnlocked");
}
const publicBaseIds = new Set(guilds.data.flatMap((guild) => guild.bases.map((base) => base.id)));
const occupiedBaseIds = new Set<string>();
let baseWorkers = 0;
for (const pal of pals.data) {
  if (pal.ownerSource !== undefined && !["save", "personal_container", "last_observed", "unresolved"].includes(pal.ownerSource)) {
    throw new Error("pals.ownerSource has an unsupported value");
  }
  if (pal.ownerResolved !== undefined && typeof pal.ownerResolved !== "boolean") {
    throw new Error("pals.ownerResolved must be boolean when present");
  }
  if (pal.placement === "base") {
    if (!pal.baseId || !publicBaseIds.has(pal.baseId)) throw new Error("base Pal must join a public guild base");
    baseWorkers++;
    occupiedBaseIds.add(pal.baseId);
  } else if (pal.baseId) {
    throw new Error("non-base Pal must not carry baseId");
  }
}

console.log(
  [
    "public API smoke ok",
    `players=${players.data.length}`,
    `pals=${pals.data.length}`,
    `guilds=${guilds.data.length}`,
    `baseWorkers=${baseWorkers}`,
    `occupiedBases=${occupiedBaseIds.size}`,
    `server=${server.data ? "available" : "unavailable"}`,
    `metrics=${metrics.data ? "available" : "unavailable"}`,
  ].join(" "),
);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optionalNonNegative(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${field} must be a non-negative integer when present`);
  }
}
