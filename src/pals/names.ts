import { baseCharacterId } from "./presentation.js";

// Prefixes the save layer stacks onto boss/raid/NPC character IDs.
const INTERNAL_PREFIX = /^(BOSS_|GYM_|RAID_|TOWER_|PREDATOR_|SUMMON_)/i;

/**
 * True when a name is a raw save identifier rather than a localized display
 * name — e.g. "PinkRabbit_Grass", "Female_People03", or a bare "BOSS_" ID.
 */
export function looksLikeInternalId(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length === 0
    || /_/.test(trimmed)
    || INTERNAL_PREFIX.test(trimmed)
    || /\d{2,}$/.test(trimmed);
}

/**
 * Best-effort readable label for a human NPC / boss that has no pinned Pal
 * entry: "BOSS_Female_People03" → "Human (Female)", "Hunter_Rifle" → "Hunter
 * Rifle". Pure string work, so it is safe before Pal knowledge has loaded.
 */
export function humanizeInternalName(characterId: string): string {
  const stripped = baseCharacterId(characterId).replace(INTERNAL_PREFIX, "").trim();
  if (!stripped) return characterId;
  const tokens = stripped
    .split(/_+/)
    .flatMap(splitCamel)
    .map((token) => token.replace(/\d+$/, ""))
    .filter(Boolean)
    // "People" is Palworld's generic human tribe token.
    .map((token) => (/^people$/i.test(token) ? "Human" : titleCase(token)));
  if (tokens.length === 0) return stripped;
  const genders = tokens.filter((token) => /^(Male|Female)$/i.test(token));
  const rest = tokens.filter((token) => !/^(Male|Female)$/i.test(token));
  const base = rest.length > 0 ? rest.join(" ") : "Human";
  return genders.length > 0 ? `${base} (${genders.join("/")})` : base;
}

/**
 * Resolve the friendliest display name for a Pal instance. The canonical pinned
 * name wins when the panel returned a raw identifier; human NPCs with no pinned
 * entry are humanized; already-friendly panel names are left untouched.
 */
export function resolvePalDisplayName(
  characterId: string,
  rawDisplayName: string,
  lookup: (baseId: string) => { name: string } | null | undefined,
): string {
  const known = lookup(baseCharacterId(characterId));
  if (known?.name && !looksLikeInternalId(known.name)) {
    // Once the save CharacterID has an exact pinned match, its localized name
    // is authoritative. Never let a friendly-looking placeholder override it.
    return known.name;
  }
  return looksLikeInternalId(rawDisplayName) ? humanizeInternalName(characterId) : rawDisplayName;
}

function splitCamel(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

function titleCase(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}
