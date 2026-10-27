# GrokBuild to Grok Bots

Let **Grok Build** (the `grok` CLI) or **Cursor** wake any of your Grok Bots or send one a prompt, through each bot's own **webhook-triggered routine**, the documented way to wake a Grok Bot from outside. It ships one small stdio MCP server, `grokbots`, with a roster of bots, confirm-gated sends and an optional read-only mode, plus three setup skills.

Each installer uses their own routine URLs and keys. There's no shared service and no provider-held credential, and the plugin doesn't use the undocumented Grok Bot gateway.

## What this plugin is

| Piece | Role |
|-------|------|
| `grokbots` MCP (one server) | Read tools: `list_bots`, `check_bot`, `describe_boundary` (no network). Write tools: `wake_bot`, `send_prompt`, which make **one** HTTPS POST to the bot's routine and are a dry-run unless `confirm=true`. Optional **read-only mode** (`GROKBOTS_READ_ONLY`) hides the write tools |
| Skills | `grokbots-send` (caller: how to wake or prompt a bot), `grokbots-roster` (caller: env vars and roster file), `grokbots-routine-setup` (inside the Grok Bot: create or reuse the webhook routine and hand over URL + key safely) |

What it does **not** do: return the bot's reply (the bot answers in its own app or channel), retry, poll, run a relay server, or touch any undocumented gateway.

## Layout (Grok-canonical, Cursor dual-support)

| Path | Purpose |
|------|---------|
| `.grok-plugin/plugin.json` | **Primary** Grok Build / marketplace manifest (includes `variables`) |
| `.mcp.json` | MCP server for Grok Build: one `grokbots` entry using `${GROK_PLUGIN_ROOT}` |
| `plugin.json` | Root manifest (Agent Plugin format) pointing at `.mcp.json` |
| `.cursor-plugin/plugin.json` + `mcp.json` | Cursor manifest + MCP config using `${CURSOR_PLUGIN_ROOT}` |
| `skills/` | Skill folders with `SKILL.md` |
| `mcp/grokbots` | TypeScript sources and tests for the stdio server (`npm test`) |
| `scripts/bootstrap-mcp.sh` / `.ps1` | **Required** after clone: `npm ci` + `npm run build` |
| `assets/logo.svg` | Marketplace logo |

## Install — Grok Build

Marketplace (once listed): install `grokbuild-grokbots` from the xAI plugin marketplace, then run the bootstrap script once from the plugin root.

Local / manual:

```bash
git clone https://github.com/matthew-rutledge-dev/grokbuild-grokbots ~/.grok/plugins/grokbuild-grokbots
bash ~/.grok/plugins/grokbuild-grokbots/scripts/bootstrap-mcp.sh
# Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File $HOME\.grok\plugins\grokbuild-grokbots\scripts\bootstrap-mcp.ps1
# or: grok --plugin-dir /path/to/grokbuild-grokbots …
```

## Install — Cursor

```bash
git clone https://github.com/matthew-rutledge-dev/grokbuild-grokbots ~/.cursor/plugins/local/grokbuild-grokbots
bash ~/.cursor/plugins/local/grokbuild-grokbots/scripts/bootstrap-mcp.sh
```

Then reload the window (**Developer: Reload Window**). Symlinks into `~/.cursor/plugins/local` only load if they resolve inside that folder, so clone or copy instead.

## Grok Bot

Inside a Grok Bot, the useful piece is the `grokbots-routine-setup` skill. It's the receiving side, so the bot creates the routine whose URL and key you give to Grok Build or Cursor. Before a marketplace listing is approved, the Grok Bot app doesn't load an unlisted plugin's MCP server. You can still follow the skill's steps by hand or paste them into the bot.

## Set up (two minutes)

1. **In the Grok Bot:** ask it to "set up grokbots routine setup", or follow `skills/grokbots-routine-setup/SKILL.md`. It creates one webhook-triggered routine and shows you its **POST URL** and **key**.
2. **In Grok Build / Cursor:** set the plugin variables `GROKBOTS_WEBHOOK_URL` and `GROKBOTS_WEBHOOK_KEY`, or use a roster file for several bots (see `skills/grokbots-roster/SKILL.md`). Reload.
3. Ask: "list my grok bots", then "wake example-agent". You get a dry-run first, then confirm.

## Plugin variables

| Variable | Required | Meaning |
|---|---|---|
| `GROKBOTS_WEBHOOK_URL` | for the env bot | Routine POST URL (https; plain http only to loopback for tests) |
| `GROKBOTS_WEBHOOK_KEY` | for the env bot | Routine sender key. Never commit it or paste it in chat |
| `GROKBOTS_DEFAULT_BOT` | no | Roster name of the env bot (default `default`) |
| `GROKBOTS_ROSTER_FILE` | no | JSON roster for several bots; keys come from `keyFile` (recommended) or `keyEnv`, never inline |
| `GROKBOTS_SENDER` | no | `from` label in each POST (default `grokbuild`) |
| `GROKBOTS_READ_ONLY` | no | `1`/`true`/`yes`/`on` hides the write tools; `0`/`false`/`no`/`off`/unset = off; **any other value = on** (fails closed, one warning on stderr) |

Unset variables that a host passes through literally (`${GROKBOTS_WEBHOOK_URL}`) count as unset.

## Network endpoints and credentials

| Endpoint | When | Purpose |
|---|---|---|
| Your routine's POST URL (`GROKBOTS_WEBHOOK_URL` or roster `url`) | Only on `wake_bot` / `send_prompt` with `confirm=true` | One POST: `Content-Type: application/json`, `Authorization: Bearer <key>`, `X-Automation-Key: <key>`, 8 s timeout, no retry, no redirects |

POST bodies: `{kind:"wake", reason, from, sentAt, requestId}` or `{kind:"prompt", prompt, from, replyHint?, sentAt, requestId}`. They carry no tokens. Responses are truncated to 2000 chars. Tool output redacts the URL's last path segment and never includes keys. No telemetry, no postinstall scripts, and nothing is downloaded or executed.

## Tests

```bash
cd mcp/grokbots && npm ci && npm test   # 12 tests; a loopback mock stands in for the routine
```

CI runs typecheck, build and tests on ubuntu-latest and windows-latest (Node 20).

## Related

- [grokbot-discord-fleet](https://github.com/matthew-rutledge-dev/grokbot-discord-fleet), where this split came from (Discord-specific fleet tools and the Discord wake bridge docs).

## Secrets

Keep routine URLs, keys and roster files out of git. Placeholders in this repo (`example-agent`, `https://example.com/webhook`, `11111111`) are not real.

## License

MIT, see [LICENSE](LICENSE).
