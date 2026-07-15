# Third-party notices

## General Palworld knowledge summaries

The factual summaries in `src/knowledge/general.ts` are adapted from pages on
The Palworld Wiki and are licensed under
[Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
The summaries were condensed and reworded for the bot. Source pages:

- [Meteorite Fragment](https://palworld.wiki.gg/wiki/Meteorite_Fragment)
- [Ancient Civilization Core](https://palworld.wiki.gg/wiki/Ancient_Civilization_Core)
- [Ancient Civilization Parts](https://palworld.wiki.gg/wiki/Ancient_Civilization_Parts)
- [Dog Coin](https://palworld.wiki.gg/wiki/Dog_Coin)
- [Technology](https://palworld.wiki.gg/wiki/Technology)
- [Refined Ingot](https://palworld.wiki.gg/wiki/Refined_Ingot)

An optional locally generated article corpus may be created with
`npm run knowledge:ingest`. Every stored section retains its source page URL,
revision ID, retrieval timestamp, source label, and license. The generated corpus
is runtime data and is not included in Palhelm distributions.

Only this adapted corpus is offered under CC BY-SA 4.0; Palhelm's original code
remains under its repository license. Palworld names and game concepts belong to
Pocketpair. This is an unaffiliated fan project.

Official Palworld 1.0 and 1.0.1 patch summaries in the same source file are
separately attributed to Pocketpair and are not represented as CC BY-SA wiki
content. Their entries link directly to the official Steam announcements.

## Encounter-location cache

`npm run knowledge:locations` creates a local cache of the Palworld Wiki's
`LocationEntity` Cargo table. Each cache records the source URL, query shape,
retrieval time, and CC BY-SA 4.0 license. The importer is bounded and polite; the
generated runtime cache is not included in Palhelm distributions. Coordinates
are labeled as in-game map coordinates and are never treated as live player or
raw server-world positions.

## Optional supplemental Pal portraits

`npm run icons:extras -- /path/to/pal-icons` installs a small, explicit allowlist
of portraits from
[The Palworld Wiki](https://palworld.wiki.gg/) for named human and Terraria
crossover CharacterIDs that are not present in the base paldeck icon source.
The downloaded files and their `fallback-sources.json` provenance sidecar are
runtime data and are not included in Palhelm distributions. Wiki content is
available under [Creative Commons Attribution-ShareAlike
4.0](https://creativecommons.org/licenses/by-sa/4.0/). Palworld and Terraria
artwork remains the property of its respective rights holders; Palhelm is an
unaffiliated fan project.
