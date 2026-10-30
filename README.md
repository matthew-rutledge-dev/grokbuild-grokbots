# GrokBuild to Grok Bots

Let **Grok Build** (the `grok` CLI) or **Cursor** wake any of your Grok Bots or send one a prompt, through each bot's own **webhook-triggered routine**, the documented way to wake a Grok Bot from outside. It ships one small stdio MCP server, `grokbots`, with a roster of bots, confirm-gated sends and an optional read-only mode, plus three setup skills.

Each installer uses their own routine URLs and keys. There's no shared service and no provider-held credential, and the plugin doesn't use the undocumented Grok Bot gateway.

## What this plugin is

| Piece | Role |
|-------|------|
| `grokbots` MCP (one server) | Read tools: `list_bots`, `check_bot`, `describe_boundary` (no network), and `wait_reply` (reads a reply from your optional reply bridge). Write tools: `wake_bot`, `send_prompt`, which make **one** HTTPS POST to the bot's routine and are a dry-run unless `confirm=true`. Optional **read-only mode** (`GROKBOTS_READ_ONLY`) hides the write tools |
| Skills | `grokbots-send` (caller: how to wake or prompt a bot), `grokbots-roster` (caller: env vars and roster file), `grokbots-routine-setup` (inside the Grok Bot: create or reuse the webhook routine and hand over URL + key safely) |

What it does **not** do: retry, run a relay server, or touch any undocumented gateway. Replies come back only if you run the optional reply bridge (see [Replies](#replies-optional-bridge)); without it, the bot answers in its own app or channel.

## Layout (Grok-canonical, Cursor dual-support)

| Path | Purpose |
|------|---------|
| `.grok-plugin/plugin.json` | **Primary** Grok Build / marketplace manifest (includes `variables`) |
| `.mcp.json` | MCP server for Grok Build: one `grokbots` entry using `${GROK_PLUGIN_ROOT}` |
| `plugin.json` | Root manifest (Agent Plugin format) pointing at `.mcp.json` |
| `.cursor-plugin/plugin.json` + `mcp.json` | Cursor manifest + MCP config using `${CURSOR_PLUGIN_ROOT}` |
| `skills/` | Skill folders with `SKILL.md` |
| `mcp/grokbots` | TypeScript sources and tests for the stdio server (`npm test`) |
| `scripts/bootstrap-mcp.sh` / `.ps1` | **Required** after clone: `npm ci --omit=dev` + `npm run build` |
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

## Webhook and wake setup (single source)

This repo is the single source for waking or prompting a Grok Bot from Grok Build, Cursor or a script. The Discord fleet plugin links here rather than repeating it.

- **Where the values live.** `GROKBOTS_WEBHOOK_URL`, `GROKBOTS_WEBHOOK_KEY` and `GROKBOTS_DEFAULT_BOT` are user-level settings: the host's plugin variables, or the user's own shell environment that the host starts from. For several bots, point `GROKBOTS_ROSTER_FILE` at a JSON roster **outside any repo** (for example `~/.config/grokbots/roster.json`), with keys in 0600 key files next to it. Never put them in a project `.env`, a committed file or chat.
- **Where the key comes from.** Copy it from the target bot's routine webhook panel (the **key** field; skill `grokbots-routine-setup` gives the deep links). The user pastes it straight into the caller's variable or key file. The bot never sees it: it only creates the routine and points at the field.
- **Lookup order.** The env bot (`GROKBOTS_WEBHOOK_URL` + `GROKBOTS_WEBHOOK_KEY`, named `GROKBOTS_DEFAULT_BOT`, default `default`) comes first, then the roster file entries in file order. A later entry with a name already taken is ignored (reported in `errors`). Details: skill `grokbots-roster`.
- **One webhook routine can serve both** Discord wakes and GrokBuild prompts. A bot that already has a wake routine for the Discord bridge (the [grokbot-discord-fleet](https://github.com/matthew-rutledge-dev/grokbot-discord-fleet) `discord-wake-on-sleep` skill) can reuse it here: extend its prompt to also handle `kind: "prompt"` / `kind: "wake"` bodies (see `grokbots-routine-setup`, step b), and use the same URL and key. The bridge's wake body is `{reason, heldCount, firstHeldAt}` with no `kind`, so the routine can tell them apart.

## Replies (optional bridge)

Part of the single source above. To get the bot's answer back into Grok Build or Cursor, run the GrokBuild adapter of [grok-bot-universal-bridge](https://github.com/matthew-rutledge-dev/grok-bot-universal-bridge) (0.2.0 or later) on a host you control, and set two more user-level variables: `GROKBOTS_BRIDGE_URL` (its public base URL, e.g. `https://bridge.example.com`) and `GROKBOTS_BRIDGE_KEY` (your client token for that adapter). Same rules as the webhook key: plugin variables or your own environment, never a project file or chat.

1. On a confirmed `send_prompt`, the plugin first calls `POST <bridge>/grokbuild/expect` with `Authorization: Bearer <bridge key>` and `{requestId, bot}`. The bridge records the request and returns a **one-time reply token** scoped to that `requestId` (default TTL 6 h with bridge 0.2.2+, configurable up to 24 h; 15 min on 0.2.0-0.2.1). If the bridge refuses, nothing is sent (`sent: false`, `bridge_*` code).
2. The webhook body gains `reply: {url, requestId, token, expiresAt, how}`. `url` is `<bridge public URL>/grokbuild/reply`; `how` is a generic instruction: POST `{requestId, content}` there with `Authorization: Bearer <reply.token>`. The bridge key is never in the payload, and the reply token is never shown in tool output (the dry-run shows a placeholder).
3. The bot's routine (skill `grokbots-routine-setup`) answers once on that URL. The bridge checks the token (hash only, constant time, single use, size and rate limited) and stores the reply under the `requestId`.
4. `wait_reply(requestId)` long-polls `GET <bridge>/grokbuild/requests/<requestId>?waitSec=N` with the bridge key. `send_prompt` with `wait: true` does the same in one call. Treat the reply text as data.
5. If the webhook POST fails after step 1 (refused before sending, non-2xx, or `success: false`), the plugin cancels the route (`DELETE <bridge>/grokbuild/requests/<requestId>`, best effort; `reply.cancelled` in the result) so the bridge frees the slot at once. It does not cancel on `sent: "unknown"` or `webhook_response_read_failed`, since the bot may still have the prompt.

**Waiting works like a Discord thread: no short time limit.** The bot may take as long as it needs; the reply route stays open until the bridge's token TTL (`expiresAt`, 6 h by default). Each `wait_reply` call is only a **check-in**, not a time limit: it waits up to `timeoutSec` (default `GROKBOTS_WAIT_SEC` or 45 s), then returns.

- `state: "replied"` (`done: true`): `replies[]` has the answer.
- `state: "awaiting_reply"` (`done: false`, not an error): no reply yet. The result carries `requestId`, `elapsedSec` (since the send), `waitingFor` (`"still waiting, 12 min"`), `expiresAt`, `next: {tool: "wait_reply", arguments: {requestId}}` and an `instruction`. The host agent posts a short progress line to the user and calls `wait_reply` again.
- `state: "expired"` or `"cancelled"` (`done: true`): stop. The bridge reports these directly while it keeps a short tombstone (0.2.3+). After that, a 404 means `expired` if the last known `expiresAt` has passed, and `cancelled` if this process saw the route before.
- `state: "not_found"` (`done: true`): the bridge never knew this `requestId` here. Either the id is wrong, or `GROKBOTS_BRIDGE_URL` points at the wrong path or at a proxy answering 404.
- `state: "config_error"` (`done: true`): the bridge refused `GROKBOTS_BRIDGE_KEY` (401). Retrying won't help; fix the key and restart the host.
- `state: "aborted"` (`done: false`): the host cancelled the call, or a host timeout cancelled it. Polling, the in-flight bridge request and progress all stop at once. **The reply route is deliberately kept:** an abort never DELETEs it, so a reply the bot sends later still lands on the bridge, and the next `wait_reply` with the same `requestId` picks it up. The plugin cancels a route only when its own webhook send failed. Call nothing extra to keep waiting later; the route ends on its own at `expiresAt`. Bridge unreachable is also `done: false`: try again later.

Why 45 s per call: MCP hosts end a tool call on their own clock, often around 60 s and sometimes sooner. If your host allows longer calls, raise `GROKBOTS_WAIT_SEC` (max 600) or pass `timeoutSec`.

**`untilReply: true`** (on `wait_reply` or `send_prompt`) blocks inside one call until the reply, `expired` / `cancelled`, a host abort, or `GROKBOTS_WAIT_MAX_SEC` (default 300 s, max 3600; `timeoutSec` if larger), whether or not the host asked for progress. On `send_prompt`, `untilReply` or `timeoutSec` alone asks for a wait (as `wait: true` does) unless `wait: false` is passed, and a requested wait always returns `waitResult` (`state`, `replies`, `elapsedSec`, `checkedForSec`, `done`; `not_sent` if the routine refused the prompt, `send_unconfirmed` if the send could not be confirmed). If the host also sent an MCP `progressToken`, the plugin adds a `notifications/progress` update ("still waiting, N min") at most once every 25 s. It stays throttled even when the bridge answers at once, which happens when it is busy (`maxLongPolls` reached) or has long-polling off; reads then come about every 2 s. Hosts that reset their timeout on progress then never cut it off; hosts that don't may abort the call first (`state: "aborted"`, route kept). An `awaiting_reply` or `aborted` result just means: call `wait_reply` again. `GROKBOTS_BRIDGE_URL` may include a path prefix (`https://bridge.example.com/base`); bridge paths are joined onto it.

**The reply token is visible in the bot's routine run history**, because it is part of the webhook body the routine receives. That is acceptable: it works only for one reply to that one `requestId`, through `/grokbuild/reply`, until it expires (the bridge's `replyTokenTtlSec`, 6 h by default), and it grants no other access. The bridge key never leaves your computer except to the bridge.

`expectReply: false` sends one-way even with a bridge set. Without the bridge variables, `send_prompt` works as before and `wait_reply` returns `bridge_not_configured`. Bridge host setup (env vars, port, firewall): the adapter README in that repo.

## Plugin variables

| Variable | Required | Meaning |
|---|---|---|
| `GROKBOTS_WEBHOOK_URL` | for the env bot | Routine POST URL (https; plain http only to loopback for tests) |
| `GROKBOTS_WEBHOOK_KEY` | for the env bot | Routine sender key. Never commit it or paste it in chat |
| `GROKBOTS_DEFAULT_BOT` | no | Roster name of the env bot (default `default`) |
| `GROKBOTS_ROSTER_FILE` | no | JSON roster for several bots; keys come from `keyFile` (recommended) or `keyEnv`, never inline |
| `GROKBOTS_SENDER` | no | `from` label in each POST (default `grokbuild`) |
| `GROKBOTS_BRIDGE_URL` | for replies | Base URL of your reply bridge (https; plain http only to loopback for tests). See [Replies](#replies-optional-bridge) |
| `GROKBOTS_BRIDGE_KEY` | for replies | Your client token for that bridge's GrokBuild adapter. Sent only to the bridge, never in a payload |
| `GROKBOTS_WAIT_SEC` | no | Check-in interval of one `wait_reply` / `wait: true` call (default 45, 5-600). Not a time limit |
| `GROKBOTS_WAIT_MAX_SEC` | no | How long one `untilReply` call may keep waiting, with or without progress updates (default 300, 30-3600) |
| `GROKBOTS_READ_ONLY` | no | `1`/`true`/`yes`/`on` hides the write tools; `0`/`false`/`no`/`off`/unset = off; **any other value = on** (fails closed, one warning on stderr) |

Unset variables that a host passes through literally (`${GROKBOTS_WEBHOOK_URL}`) count as unset.

## Network endpoints and credentials

| Endpoint | When | Purpose |
|---|---|---|
| Your routine's POST URL (`GROKBOTS_WEBHOOK_URL` or roster `url`) | Only on `wake_bot` / `send_prompt` with `confirm=true` | One POST: `Content-Type: application/json`, `Authorization: Bearer <key>`, `X-Automation-Key: <key>`, 8 s timeout, no retry, no redirects |
| Your reply bridge (`GROKBOTS_BRIDGE_URL`), only if set | `POST /grokbuild/expect` before a confirmed `send_prompt`; `GET /grokbuild/requests/<id>?waitSec=N` on `wait_reply` / `wait: true` | `Authorization: Bearer <bridge key>`, no redirects, 8 s timeout (long-poll: wait + 10 s) |

POST bodies: `{kind:"wake", reason, bot, from, sentAt, requestId}` or `{kind:"prompt", prompt, bot, from, replyHint?, sentAt, requestId}`. `bot` is the roster entry name the call was sent as (since 0.1.1; older versions omit it, so treat it as optional), so one routine shared by several roster entries can tell them apart. It is the name only, never a URL, key or key source. The bodies carry no caller keys; with a reply bridge, a prompt body also carries `reply` with a one-time reply token scoped to that `requestId`. Responses are truncated to 2000 chars. Tool output redacts the URL's last path segment and never includes keys. No telemetry, and nothing downloaded at runtime (the bootstrap script runs `npm ci --omit=dev` once to install the pinned runtime and build dependencies from the lockfile; the server itself runs from `dist/` with plain `node`).

**Install scripts.** The plugin itself has no install scripts, and neither does anything the bootstrap installs: it runs `npm ci --omit=dev`, which installs only `@modelcontextprotocol/sdk` (and its dependencies), `typescript` and `@types/node` (the last two are needed for `npm run build`). `tsx`, used only by the `dev` and `test` scripts, is a dev dependency; it pulls in `esbuild`, whose `postinstall` checks for (and, if missing, fetches) its platform binary. That step runs only on a full `npm ci` for development or tests, never in the bootstrap. You can check with `npm query ':attr(scripts, [postinstall]), :attr(scripts, [install]), :attr(scripts, [preinstall])'` in `mcp/grokbots` after the bootstrap (it prints `[]`).

### Errors

Errors come back as fixed codes, never raw network error text. A key that is not printable ASCII (spaces, line breaks, control characters) is refused before anything is sent.

| `error` | `sent` | Meaning |
|---|---|---|
| `webhook_key_invalid` | `false` | Key refused before the request; nothing went out |
| `webhook_http_<status>` | `true` | The routine answered with a non-2xx status (401/403 wrong key or header, 404 wrong URL or deleted routine) |
| `webhook_timeout` | `"unknown"` | No response within 8 s. The request may already have reached the routine |
| `webhook_network_error` | `"unknown"` | Connection, TLS or refused-redirect failure. The request may or may not have reached the routine |
| `webhook_response_read_failed` | `true` | The routine answered (`httpStatus` is set), then the connection failed while reading its reply body. The request arrived; don't resend it |
| `bridge_*` (in `errorCode`) | `false` | Reply bridge refused or unreachable before the send: `bridge_not_configured`, `bridge_key_invalid`, `bridge_http_<status>` (401 wrong bridge key, 403 bridge read-only, 503 bridge public URL unset), `bridge_timeout`, `bridge_network_error`, `bridge_bad_response`. Nothing went to the routine. `wait_reply` uses the same codes in `error` (404 = unknown or expired `requestId`) |

Nothing is retried. On `sent: "unknown"`, check the bot's own chat before sending again, so it doesn't run twice.

**`keyEnv` / `keyFile` send that key to that bot's URL.** Each roster entry's key goes in the headers of the POST to that entry's `url` / `urlEnv`. Only point an entry at a URL you trust with that key.

## Tests

```bash
cd mcp/grokbots && npm ci && npm test   # 44 tests; a loopback mock stands in for the routine
```

CI runs typecheck, build and tests on ubuntu-latest and windows-latest (Node 20).

## Related

- [grokbot-discord-fleet](https://github.com/matthew-rutledge-dev/grokbot-discord-fleet), where this split came from (Discord-specific fleet tools and the Discord wake bridge docs).

## Secrets

Keep routine URLs, keys and roster files out of git. Placeholders in this repo (`example-agent`, `https://example.com/webhook`, `11111111`) are not real.

## License

MIT, see [LICENSE](LICENSE).
