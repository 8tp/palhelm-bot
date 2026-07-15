<p align="center"><img src="assets/banner.png" alt="Palhelm" width="820"></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933" alt="Node >= 20">
  <img src="https://img.shields.io/badge/discord.js-14-5865F2" alt="discord.js 14">
  <a href="https://docs.palhelm.com"><img src="https://img.shields.io/badge/docs-docs.palhelm.com-6b7f3f" alt="docs.palhelm.com"></a>
  <a href="https://github.com/8tp/palhelm-bot/actions/workflows/ci.yml"><img src="https://github.com/8tp/palhelm-bot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

A Discord companion bot for [Palhelm](https://github.com/8tp/palhelm), the self-hosted Palworld admin panel. It posts live server notifications (backups, shutdown countdowns, optional join/leave) into a channel, and answers slash commands with data from the panel, including rendered map and pal-icon images.

It requires a running Palhelm panel to talk to. Full docs: [docs.palhelm.com](https://docs.palhelm.com).

Palhelm panel v0.5.0 or newer is recommended. Older panels continue to support
the core save/REST commands; live world summaries, exact base-worker answers,
and worker-aware AI tools degrade to an explicit unavailable state when their
optional Integration endpoints are absent.

## Commands

| Command | Who | What |
|---|---|---|
| `/status` | everyone | Server name, state, version, uptime, players, day, FPS |
| `/players` | everyone | Who is online right now |
| `/player <name>` | everyone | Player profile plus their top pals (autocomplete) |
| `/pal <pal> [player]` | everyone | Inspect one owned pal instance: work suitability, stats, skills, placement |
| `/profile link\|status\|unlink` | everyone | Link Discord to an unclaimed Palworld player for personalized commands and AI |
| `/pals <name>` | everyone | A player's pals as an icon-grid image |
| `/box <name> [page]` | everyone | Browse a player's Pal box with page buttons |
| `/map [layer] [pal]` | everyone | World map with guild bases plus optional attributed Pal encounter lookup |
| `/guilds` | everyone | Guilds, members, base counts |
| `/metrics` | everyone | FPS, frame time, players, day, uptime, base camps |
| `/history [filter]` | everyone | Recent joins, leaves, backups, and panel event summaries |
| `/leaderboard [category]` | everyone | Level, playtime, current pal, rare pal, and guild rankings |
| `/compare <a> <b>` | everyone | Side-by-side current player cards |
| `/trends [window]` | everyone | Level, playtime, and current-roster movement over time |
| `/whohas <pal>` | everyone | Find current owners of an observed Pal species |
| `/records` | everyone | Navigable current records and observed holder-change history |
| `/collection [player]` | everyone | Canonical 306-Pal completion, missing species, and rare variants |
| `/dex <pal>` | everyone | Rich 1.0 mechanics, ownership, and cached sourced drops/habitats/encounters |
| `/breed <child> [player]` | everyone | Parent pairs ranked by what is currently owned |
| `/breedpath <target> [scope] [player] [passive] [track]` | everyone | Personal gender-aware breeding chain with passive carriers and goal saving |
| `/workers <job> [player]` | everyone | Rank current workers for a base job |
| `/team <purpose> [player]` | everyone | Combat-party or base-role recommendations |
| `/rare [player]` | everyone | Current Boss, Alpha, and Lucky gallery |
| `/goal add\|list\|remove` | everyone | Restart-safe pal goals with completion notifications |
| `/progress [player]` | everyone | Lifetime captures, unique captures, and Paldeck unlocks |
| `/ask <question> [private]` | everyone | Optional read-only AI guide using server tools, pinned 1.0 knowledge, and cited web search |
| `/help` | everyone | Categorized directory of every bot command |
| `/diagnostics` | admin role | Cache, knowledge, history, AI, and automation status |
| `/profileadmin assign\|clear` | admin role | Reassign or clear Discord-to-Palworld player links |
| `/backup` | admin role | Trigger a world backup now |
| `/backups` | admin role | Recent backups plus the schedule |
| `/announce <msg>` | admin role | In-game broadcast |

"Admin role" is the Discord role in `ADMIN_ROLE_ID`. Scope it to trusted people; these commands act on the game server. Discord's built-in Administrator permission is not required; the configured role is the runtime authority.

## How it talks to Palhelm

- **Reads** use the panel's read-only Integration API (`/api/integration/v1`) with a bearer key (the `phk_` prefix). That surface is redacted by design: nothing it returns is unsafe in a public channel (no platform IDs, live positions, ping, or ban state).
- **Everything the Integration API cannot do** (triggering backups, the event stream that powers notifications, in-game announcements, and the binary map tiles and pal icons) uses the panel's session API by logging in with the panel admin password, with automatic re-login on expiry.

Map tiles and Pal icons must have been fetched on the panel host (the panel repo's
`scripts/fetch-map-tiles.sh` and `scripts/fetch-pal-icons.sh`); when absent the
bot degrades to text-only replies. The icon fetcher discovers the current roster
from paldeck.cc and stores files by canonical CharacterID; boss-prefixed save IDs
are normalized by the bot before lookup, so nicknames, Alpha/Boss instances, and
Lucky instances use the base species portrait. Operators can audit the live roster
with `npm run icons:audit` and install the small attributed named-human/crossover
allowlist with `npm run icons:extras -- /path/to/pal-icons`; see
`THIRD_PARTY-NOTICES.md` for provenance.

## Social tracking

One shared five-minute snapshot cache feeds leaderboards, comparisons, Pal ownership lookup, bot presence, milestones, and the weekly digest, so commands do not independently poll the panel. The first successful snapshot is a silent baseline, and milestone claims are explicitly observations made since tracking began. Save-format drift on the panel side suppresses inferred milestones.

Observation state is written restart-safely beneath `BOT_DATA_DIR` (`data/` by
default). Milestones are enabled by default. The weekly digest is opt-in and uses
the host's local timezone; configure its weekday and hour in `.env.example`.
Known, persistent parser drift can be trusted with
`HISTORY_ALLOW_FORMAT_DRIFT=true`; this requires two consecutive structurally
consistent snapshots and rejects empty or collapsed results.

Pal goals are stored atomically in `BOT_DATA_DIR` and complete only when a new
matching instance is observed after the goal was created. Optional health alerts
use fresh-snapshot hysteresis for sustained low FPS, stale-save/backup state, and
recovery; they are notification-only and never remediate or restart anything.
Enable them with `HEALTH_ALERTS_ENABLED=true`.

`/ask` is optional and uses OpenRouter when `OPENROUTER_API_KEY` is configured.
It can call deterministic read-only tools backed by the shared public snapshot,
a disk-cached, version-pinned Palworld 1.0 mechanical dataset, and—when
`SEARXNG_URL` is configured—a Palworld-scoped read-only web search for general
game knowledge. It has no session/admin, backup, announcement, shell, or mutation
tool. The knowledge tools cover Pal search/details, work suitability, stats, active-skill
power/cooldowns, guaranteed passive traits, wild level ranges, movement/food/stamina,
exact breeding pairs, reverse breeding lookup, and owned-worker recommendations.
The pinned mechanical dataset does not cover every partner-skill description,
recipe, or technology unlock. An optional attributed encounter cache supplies
wild habitats, level ranges, and map coordinates to `/dex`, `/map pal:`, and AI
location tools; build or refresh it with `npm run knowledge:locations`. Other
gaps use web search when available and are reported instead of guessed. Web
snippets are treated as untrusted and may be version-sensitive. Successful searches use a bounded, mode-0600 restart-safe cache;
an explicitly labeled last-good result may be used briefly when search is offline.
Common material and technology questions first use a small attributed, versioned
CC BY-SA corpus (see `THIRD_PARTY-NOTICES.md`), avoiding a live search for topics
such as Meteorite Fragments, Dog Coins, and Ancient Civilization materials.
Requests use providers that deny data collection and require
zero data retention. Configure the model, daily request limit, per-user cooldown,
and optional SearXNG base URL in `.env.example`.

The knowledge cache is built from PalCalc v1.17.2 (MIT; canonical Palworld 1.0
roster and breeding matrix) and a pinned Palworld Save Pal dataset (mechanical
elements/work/stats/learnsets). PalCalc also supplies the expanded mechanical fields;
its partner-skill field is unpopulated in this pinned release. Palworld Save Pal states MIT in its README but has
no standalone LICENSE file, so the bot excludes descriptions and artwork, retains
source provenance, and can continue from the last good cache when upstream is down.

## Setup

Prereq: Node 20 or newer, and a running Palhelm panel.

1. **Discord application.** At <https://discord.com/developers/applications>: create an app, then on the Bot tab use Reset Token and copy the token. No privileged intents are needed; leave Presence, Members, and Message Content off.
2. **Invite the bot** (scopes `bot` + `applications.commands`; permissions: Send Messages, Embed Links, Attach Files):

   ```text
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=51200
   ```

3. **Integration key.** In the panel as admin, open Settings, Integration API, and create a key labeled `discord-bot` (or `POST /api/v1/integration-keys`). The plaintext key is shown exactly once; copy it then.
4. **Configure.** `cp .env.example .env` and fill it in. Every variable is documented in the file. The main ones:

   | Key | What it is |
   |---|---|
   | `DISCORD_TOKEN` | bot token from the Developer Portal |
   | `DISCORD_APPLICATION_ID` | application ID from the Developer Portal |
   | `DISCORD_GUILD_ID` | your Discord server ID, e.g. `000000000000000000` |
   | `NOTIFY_CHANNEL_ID` | channel for backup and server notifications |
   | `ACTIVITY_CHANNEL_ID` | optional separate channel for the join/leave feed |
   | `MILESTONES_CHANNEL_ID` | optional dedicated channel for milestone cards |
   | `ADMIN_ROLE_ID` | role allowed to run admin commands |
   | `SERVER_LABEL` | public display name used in embeds and presence |
   | `PALHELM_BASE_URL` | panel URL, no trailing slash, e.g. `http://palhelm.lan:8080` |
   | `PALHELM_INTEGRATION_KEY` | the bearer key from step 3 |
   | `PALHELM_ADMIN_PASSWORD` | panel admin password, for the parts the read-only API does not cover |

   Treat the token, the key, and the password like passwords. Never commit `.env`. See [SECURITY.md](SECURITY.md).
5. **Install and register commands** (re-run `register` whenever commands change; guild-scoped registration shows up instantly):

   ```sh
   npm install
   npm run register
   ```

6. **Run**:

   ```sh
   npm start        # or: npm run dev (watch mode)
   ```

   Keep it alive with your supervisor of choice (systemd unit, docker, pm2).

## Development

```sh
npm run typecheck            # tsc --noEmit
npm test                     # vitest run
npm run knowledge:locations  # refresh attributed encounter data under BOT_DATA_DIR
npm run icons:audit          # compare the live roster with the panel icon cache
```

`src/palhelm/` holds the two API clients, `src/snapshots/` the shared polling
boundary, `src/history/` durable observations and scheduled social features,
`src/commands/` one module per slash command, and `src/notify/` the event-stream
to-channel bridge. See [CONTRIBUTING.md](CONTRIBUTING.md). The wider feature plan is in the
panel repository's [bot roadmap](https://github.com/8tp/palhelm/blob/main/docs/BOT-ROADMAP.md).

## Related

- **Panel:** [github.com/8tp/palhelm](https://github.com/8tp/palhelm)
- **Docs:** [docs.palhelm.com](https://docs.palhelm.com)
- **Site:** [palhelm.com](https://palhelm.com)

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY-NOTICES.md](THIRD_PARTY-NOTICES.md). Palworld names and game concepts belong to Pocketpair. This is an unaffiliated fan project.
