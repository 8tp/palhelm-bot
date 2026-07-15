import "dotenv/config";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { IntegrationClient } from "../src/palhelm/integration.js";
import { SessionClient } from "../src/palhelm/session.js";
import { baseCharacterId, palIconCandidateIds } from "../src/pals/presentation.js";
import { PalKnowledgeService } from "../src/knowledge/paldeck.js";

const config = loadConfig();
const integration = new IntegrationClient(config.palhelmBaseUrl, config.integrationKey);
const session = new SessionClient(config.palhelmBaseUrl, config.adminPassword);
const knowledge = new PalKnowledgeService(join(config.dataDir, "pal-knowledge.json"));
await knowledge.init();

const pals = (await integration.pals()).data;
const byId = new Map<string, { names: Set<string>; count: number }>();
for (const pal of pals) {
	const id = pal.characterId.trim();
  const row = byId.get(id.toLocaleLowerCase("en-US")) ?? { names: new Set<string>(), count: 0 };
  row.names.add(pal.displayName);
  row.count++;
  byId.set(id.toLocaleLowerCase("en-US"), row);
}

const missing: string[] = [];
let canonicalPresent = 0;
for (const [id, row] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
	const known = knowledge.getExact(baseCharacterId(id)).data;
	const candidates = palIconCandidateIds(id);
  let present = false;
  for (const candidate of candidates) {
    if (await session.binary(`/api/v1/paldeck/icon/${encodeURIComponent(candidate)}`)) {
      present = true;
      break;
    }
  }
  if (present) canonicalPresent++;
  else missing.push(`${id}\t${known?.name ?? [...row.names].join("|")}\t${row.count}`);
}

const dataset = await session.binary("/api/v1/paldeck/icon-dataset");
let installedCount: number | null = null;
if (dataset) {
  try {
    const parsed = JSON.parse(dataset.buffer.toString("utf8")) as { count?: unknown };
    if (typeof parsed.count === "number") installedCount = parsed.count;
  } catch {
    // The per-ID audit remains authoritative for currently observed Pals.
  }
}
console.log(`icon audit observedSpecies=${byId.size} resolved=${canonicalPresent} missing=${missing.length} installedDataset=${installedCount ?? "unknown"}`);
for (const row of missing) console.log(row);
