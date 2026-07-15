/**
 * Read-only post-deploy smoke check for Palhelm's public Integration API.
 * Prints counts and availability only: never player data, URLs, keys, or bodies.
 */
import "dotenv/config";
import { IntegrationClient } from "../src/palhelm/integration.js";

const baseUrl = required("PALHELM_BASE_URL").replace(/\/+$/, "");
const key = required("PALHELM_INTEGRATION_KEY");
const client = new IntegrationClient(baseUrl, key);

const [players, pals, guilds, server, metrics, worldSummary, liveWorkers] = await Promise.all([
  client.players(),
  client.pals(),
  client.guilds(),
  client.server(),
  client.metricsCurrent(),
  client.worldSummary(),
  client.worldWorkers(),
]);

for (const player of players.data) {
  optionalNonNegative(player.captureTotal, "players.captureTotal");
  optionalNonNegative(player.uniquePalsCaptured, "players.uniquePalsCaptured");
  optionalNonNegative(player.paldeckUnlocked, "players.paldeckUnlocked");
}
const publicBaseIds = new Set(guilds.data.flatMap((guild) => guild.bases.map((base) => base.id)));
for (const worker of liveWorkers.data.workers) {
  if (!worker.instanceId || !worker.baseId || !publicBaseIds.has(worker.baseId)) {
    throw new Error("live worker must have an exact Pal identity and public base join");
  }
  if (!(worker.hpPercent === null || (worker.hpPercent >= 0 && worker.hpPercent <= 100))) {
    throw new Error("live worker hpPercent must be null or a percentage");
  }
}
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
    `gameData=${worldSummary.data.state}`,
    `gameDataActors=${Object.values(worldSummary.data.counts).reduce((sum, value) => sum + value, 0)}`,
    `liveWorkers=${liveWorkers.data.workers.length}`,
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
