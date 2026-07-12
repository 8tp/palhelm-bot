import type { Pal, PlayerSummary, RosterPal } from "../types.js";

const BOSS_PREFIX = /^boss_/i;

/** Species ID without instance-variant prefixes used by Palworld save records. */
export function baseCharacterId(characterId: string): string {
  let value = characterId.trim();
  while (BOSS_PREFIX.test(value)) value = value.replace(BOSS_PREFIX, "");
  return value || characterId;
}

export function isBossVariant(pal: Pick<Pal, "characterId">): boolean {
  return BOSS_PREFIX.test(pal.characterId.trim());
}

/** Discord-facing variant marks: crown for explicit boss IDs, star for other Alphas. */
export function palVariantTags(pal: Pick<Pal, "characterId" | "isAlpha" | "isLucky">): string {
  const strength = isBossVariant(pal) ? " 👑" : pal.isAlpha ? " ⭐" : "";
  return `${strength}${pal.isLucky ? " 🍀" : ""}`;
}

export function palOwnerLabel(pal: RosterPal, players: readonly PlayerSummary[] = []): string {
  const name = pal.ownerName.trim() || players.find((player) => player.uid === pal.ownerUid)?.name || "Owner unavailable";
  return pal.ownerSource === "last_observed" && name !== "Owner unavailable"
    ? `${name} (last observed)`
    : name;
}
