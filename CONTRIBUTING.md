# Contributing to the Palhelm Discord bot

Thanks for helping. The bot is a TypeScript Node project run with `tsx`; there is no build step.

## Prerequisites

- Node 20 or newer (see `engines` in `package.json`).
- A running [Palhelm](https://github.com/8tp/palhelm) panel if you want to exercise the bot for real. The test suite does not need one.

## Setup and checks

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

CI runs exactly those two checks. Both must pass.

To run the bot itself, copy `.env.example` to `.env` and fill it in (every variable is documented in the file), then:

```sh
npm run register    # register slash commands; re-run whenever commands change
npm start           # or: npm run dev (watch mode)
```

## Layout

- `src/commands/` one module per slash command
- `src/palhelm/` the two panel API clients (Integration API and session API)
- `src/snapshots/` the shared polling boundary
- `src/history/` durable observations and scheduled social features
- `src/notify/` the event-stream-to-channel bridge
- `test/` the vitest suite

## Pull requests

- Keep PRs focused and add a test for new behavior.
- New commands need an entry in `/help` and the README command table.
- Plain English in docs and replies. No hype. Honest about limits: when the bot infers something from snapshots, say so.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
