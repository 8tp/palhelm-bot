/** Small, versioned general-knowledge corpus for common questions.
 *
 * The adapted factual summaries are CC BY-SA 4.0; see THIRD_PARTY-NOTICES.md.
 * Keep this deliberately small and attributable. Web search fills gaps.
 */
export interface GeneralKnowledgeEntry {
  id: string;
  title: string;
  aliases: string[];
  facts: string[];
  sourceUrl: string;
  sourceLabel: string;
}

export const GENERAL_KNOWLEDGE_VERSION = "palworld-1.0-2026-07-11";
export const GENERAL_KNOWLEDGE_LICENSE = "CC BY-SA 4.0";

const ENTRIES: GeneralKnowledgeEntry[] = [
  {
    id: "meteorite-fragment",
    title: "Meteorite Fragment",
    aliases: ["meteorite", "meteor fragment", "space rock"],
    facts: [
      "Meteorite Fragments come from Meteorite Events.",
      "A Crusher can extract Paldium Fragments from them.",
      "They are also used for the Meteor Launcher and its ammunition, plus Selyne's Saddle.",
    ],
    sourceUrl: "https://palworld.wiki.gg/wiki/Meteorite_Fragment",
    sourceLabel: "The Palworld Wiki — Meteorite Fragment",
  },
  {
    id: "ancient-civilization-core",
    title: "Ancient Civilization Core",
    aliases: ["ancient core", "civilization core", "raid core"],
    facts: [
      "Ancient Civilization Cores are advanced materials obtained from raid bosses and some late-game activities such as Oil Rig loot and higher expeditions.",
      "They are used by advanced equipment and structures including Ability Glasses, Electric Egg Incubators, higher shields, and Large Incubators.",
      "They cannot be crafted, so save them for a planned unlock instead of treating them as ordinary materials.",
    ],
    sourceUrl: "https://palworld.wiki.gg/wiki/Ancient_Civilization_Core",
    sourceLabel: "The Palworld Wiki — Ancient Civilization Core",
  },
  {
    id: "ancient-civilization-parts",
    title: "Ancient Civilization Parts",
    aliases: ["ancient parts", "civilization parts"],
    facts: [
      "Ancient Civilization Parts can come from Alpha or Lucky Pals and certain expeditions.",
      "They are widely used for Ancient Technology equipment and structures, higher-tier schematic crafting, and Pal Labor Research.",
      "They are a recurring progression material rather than a single-quest item.",
    ],
    sourceUrl: "https://palworld.wiki.gg/wiki/Ancient_Civilization_Parts",
    sourceLabel: "The Palworld Wiki — Ancient Civilization Parts",
  },
  {
    id: "dog-coin",
    title: "Dog Coin",
    aliases: ["dog coins", "mimog coin", "medal merchant currency"],
    facts: [
      "Dog Coins are currency for Medal Merchants; they are not a crafting ingredient.",
      "They can be obtained from wild Mimogs, Junkyards, and Elemental Treasure Chests.",
      "Capturing or defeating a Mimog can award them, but butchering one does not.",
    ],
    sourceUrl: "https://palworld.wiki.gg/wiki/Dog_Coin",
    sourceLabel: "The Palworld Wiki — Dog Coin",
  },
  {
    id: "technology-points",
    title: "Technology and Ancient Technology Points",
    aliases: ["technology points", "ancient technology points", "ancient tech points", "technical manual"],
    facts: [
      "Regular and Ancient Technology use separate point pools in the Technology menu.",
      "Progression awards points through leveling, Fast Travel unlocks, and first-time boss victories; Technical Manuals provide additional points.",
      "Some technologies also require a prerequisite boss victory, research, or earlier technology before they can be unlocked.",
    ],
    sourceUrl: "https://palworld.wiki.gg/wiki/Technology",
    sourceLabel: "The Palworld Wiki — Technology",
  },
  {
    id: "refined-ingot-automation",
    title: "Refined Ingot Automation",
    aliases: [
      "refined ingot",
      "refined ingots",
      "automate refined ingots",
      "refined metal automation",
    ],
    facts: [
      "One Refined Ingot costs 2 Ore and 2 Coal and is produced at an Improved Furnace.",
      "The Improved Furnace unlocks at technology tier 34 and requires a Pal with Kindling to operate.",
      "For a reliable production line, use Mining Pals for Ore and Coal, Transporting Pals to keep nearby storage supplied, and a strong Kindling Pal assigned to the furnace; you still queue the Refined Ingot order at the furnace.",
      "Ore Mining Sites automate Ore at a base. The later Ancient Technology Coal Mine automates Coal; before unlocking it, use a base around natural Coal nodes or replenish Coal manually.",
    ],
    sourceUrl: "https://palworld.wiki.gg/wiki/Refined_Ingot",
    sourceLabel: "The Palworld Wiki — Refined Ingot",
  },
];

export function searchGeneralKnowledge(query: string, limit = 3): GeneralKnowledgeEntry[] {
  const normalized = normalize(query);
  const terms = normalized.split(" ").filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  return ENTRIES
    .map((entry) => {
      const title = normalize(entry.title);
      const aliases = entry.aliases.map(normalize);
      const searchable = `${title} ${aliases.join(" ")} ${entry.facts.map(normalize).join(" ")}`;
      const exact = title === normalized || aliases.includes(normalized);
      const phrase = title.includes(normalized) || normalized.includes(title) ||
        aliases.some((alias) => alias.includes(normalized) || normalized.includes(alias));
      const matchedTerms = terms.filter((term) => searchable.includes(term)).length;
      return { entry, score: exact ? 100 : phrase ? 50 + matchedTerms : matchedTerms };
    })
    .filter((item) => item.score > 0 && (
      item.score >= 50 || item.score >= (terms.length === 1 ? 1 : Math.max(2, Math.ceil(terms.length / 2)))
    ))
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, Math.max(1, Math.min(limit, 5)))
    .map((item) => item.entry);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}
