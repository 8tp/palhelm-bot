# Changelog

## 0.2.1 — 2026-07-15

- Redacted player, owner, Pal-instance, guild, base, and save identifiers before
  AI tool evidence reaches the provider, and scrubbed identifiers repeated in
  model-authored prose or URLs while preserving deterministic source citations.
- Simplified `/ask` responses to a concise `AI Generated` footer while retaining
  attributed source links in the answer body.
- Removed raw Pal-instance and base identifiers from `/pal` output and made work
  suitability levels explicit across `/pal` and `/dex`.
- Added a deterministic, network-free `/ask` replay suite covering ownership,
  live workers, collection progress, knowledge, breeding, movement, malformed
  responses, empty evidence, identifier privacy, and citations.

## 0.2.0 — 2026-07-15

- Added exact live base-worker tools backed by Palhelm's redacted Integration API.
- Hardened AI tool execution, personal-roster grounding, deterministic fallbacks,
  response formatting, and attributed Palworld 1.0/1.0.1 knowledge retrieval.
- Added encounter-location caching, richer `/dex` and `/map` exploration, passive-
  aware breeding paths, goal tracking, historical records, weekly recap cards,
  richer milestones, and configurable Discord presence.
- Added canonical Pal icon resolution for nicknames, Boss/Alpha/Lucky variants,
  cosmetic IDs, and attributed supplemental crossover portraits.
- Kept custom admin-role authorization consistent across Discord visibility and
  runtime enforcement.

Palhelm panel v0.5.0 or newer is recommended for live-world and exact base-worker
features. Core commands remain compatible with older panels and optional endpoints
degrade to an explicit unavailable state.
