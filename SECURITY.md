# Security policy

## Token and credential handling

The bot's `.env` holds three secrets, and each one is worth protecting:

- `DISCORD_TOKEN` gives full control of your bot account. If it leaks, reset it immediately in the Discord Developer Portal (Bot tab, Reset Token).
- `PALHELM_INTEGRATION_KEY` (the `phk_` prefix) is read-only and redacted by design, but revoke it in the panel if you think it leaked; revocation takes effect on the next request.
- `PALHELM_ADMIN_PASSWORD` is the panel admin password. A leak here means full panel access: backups, restores, kicks, bans, config. Rotate it on the panel side if it leaks.

Habits worth keeping:

- Never commit `.env`. The repo ships only `.env.example` with empty values.
- Give the bot's admin commands (`/backup`, `/announce`, `/profileadmin`, `/diagnostics`) a narrowly scoped Discord role via `ADMIN_ROLE_ID`.
- The bot needs no privileged intents. Leave Presence, Members, and Message Content off.
- Keep the panel itself off the open internet (LAN or VPN/tailnet only) and point `PALHELM_BASE_URL` at that private address. See the panel's [security policy](https://github.com/8tp/palhelm/blob/main/SECURITY.md).
- If you enable `/ask`, use a spend-capped OpenRouter key. The assistant has read-only tools only, but the key is still money.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub security advisories on this repo: go to the **Security** tab at [github.com/8tp/palhelm-bot](https://github.com/8tp/palhelm-bot/security) and choose **Report a vulnerability**. Do not open a public issue or PR for a security problem.

Include what you can: affected version, setup, steps to reproduce, and impact. This is a volunteer project, so please allow a reasonable window for a fix before any public disclosure.
