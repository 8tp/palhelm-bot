import type { Pal, PlayerSummary, RosterPal } from "../types.js";

const BOSS_PREFIX = /^boss_/i;
const ICON_BASE_ALIASES: Readonly<Record<string, string>> = {
  "plantslime_flower": "plantslime",
  "grasspanda_electric_tower": "grasspanda_electric",
  "lazydragon_electric_tower": "lazydragon_electric",
};

/** Species ID without instance-variant prefixes used by Palworld save records. */
export function baseCharacterId(characterId: string): string {
  let value = characterId.trim();
  while (BOSS_PREFIX.test(value)) value = value.replace(BOSS_PREFIX, "");
  return value || characterId;
}

/**
 * Ordered icon IDs for save variants. Display names/nicknames are deliberately
 * irrelevant: image identity always comes from CharacterID. Most BOSS_ values
 * use the base species art; the named bounty target Hawk is a real exact-ID
 * exception with its own optional portrait.
 */
export function palIconCandidateIds(characterId: string): string[] {
  const raw = characterId.trim().toLocaleLowerCase("en-US");
  if (!raw) return [];
  const base = baseCharacterId(raw).toLocaleLowerCase("en-US");
  const preferred = ICON_BASE_ALIASES[base] ?? base;
  return [...new Set(raw === "boss_hunter_rifle" ? [raw, preferred] : [preferred])];
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
