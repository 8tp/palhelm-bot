import type { PalKnowledge, PalKnowledgeService } from "../knowledge/paldeck.js";
import { baseCharacterId } from "../pals/presentation.js";
import type { RosterPal } from "../types.js";

export async function readyKnowledge(service: PalKnowledgeService): Promise<void> {
  await service.init();
}

export function exactKnowledgeFor(
  service: PalKnowledgeService,
  characterId: string,
  displayName?: string,
): PalKnowledge | null {
  const base = baseCharacterId(characterId);
  const match = service.get(base).data;
  if (!match) return null;
  const id = match.internalId.toLocaleLowerCase("en-US");
  if (id === base.toLocaleLowerCase("en-US")) return match;
  if (displayName && match.name.toLocaleLowerCase("en-US") === displayName.toLocaleLowerCase("en-US")) return match;
  return null;
}

export function ownedSpecies(pals: RosterPal[]): Map<string, RosterPal[]> {
  const result = new Map<string, RosterPal[]>();
  for (const pal of pals) {
    const key = baseCharacterId(pal.characterId).toLocaleLowerCase("en-US");
    const current = result.get(key) ?? [];
    current.push(pal);
    result.set(key, current);
  }
  return result;
}

export function metadataLabel(service: PalKnowledgeService): string {
  const status = service.status();
  const versions = status.metadata?.sources.map((source) => `${source.name} ${source.version}`).join(" · ");
  return versions ? `Palworld 1.0 data · ${versions}` : "Palworld 1.0 pinned data";
}
