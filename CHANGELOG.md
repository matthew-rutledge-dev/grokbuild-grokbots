# Changelog

## 0.1.11

- **Relay mode.** When `GROKBOTS_BRIDGE_URL` + `GROKBOTS_BRIDGE_KEY` are set and the target bot has no webhook here (env bot or roster), `send_prompt` sends the prompt to the bridge instead: one `POST <bridge>/grokbuild/prompt` with the client token as Bearer and `{bot, prompt, requestId, replyHint?}` (the body the bridge's GrokBuild adapter accepts). The bridge holds the routine key and delivers (with hold, retry and wake), so this computer needs no `GROKBOTS_WEBHOOK_URL` / `GROKBOTS_WEBHOOK_KEY` for that bot. The bot name is passed as given (lowercase bridge name). Results carry `mode: "relay"` and `bridgeState` (`delivered` / `held`).
- Relay waits use the same long-poll as direct mode (`untilReply`, `wait`, `timeoutSec`, `wait_reply`). Relayed requests stay `delivered` on the bridge after the bot answers, so `delivered` with replies is reported as `replied`. While waiting, `bridgeState` shows the bridge's delivery state. Relay never sends `DELETE` (the bridge answers 409 for relayed requests); an abort keeps the request. A 404 for a relay request seen before is `expired` (the bridge keeps relayed requests for its `replyTtlSec`).
- Relay results: bridge refusal (4xx, or a 503 with a bridge error such as `reply_channel_unset`) is `not_sent` and frees the `requestId`; a 409 is `request_id_in_use`; no answer, a gateway 5xx or an unreadable answer is `send_unconfirmed` (`sent: "unknown"`, id kept, no wait).
- **Relay fail-fast:** before the POST, a confirmed relay send reads `GET /grokbuild/status`; a bot the bridge doesn't route for this client is refused with `errorCode: "bot_not_routed"` and `routedBots`, nothing sent (a status read error is also refused, nothing sent).
- **New variable `GROKBOTS_BRIDGE_DEFAULT_BOT`:** the relay bot used when `send_prompt` gets no `bot` and no direct webhook bot applies (falls back to `GROKBOTS_DEFAULT_BOT`), so the relay default can differ from the direct env bot's name. Declared in all manifests and passed through.
- `list_bots` with no roster and a bridge set lists the bots the bridge routes for this client (`GET /grokbuild/status`, writes nothing), `mode: "relay"`, with readiness (bridge writable, reply channel ready). `check_bot` on a relay name checks routing and readiness the same way. `describe_boundary` reports the active mode. `wake_bot` and `expectReply: false` need a direct webhook and say so.
- Direct mode is unchanged when the bot has a webhook here.
- **Fix (direct mode): a gateway 502/503/504/524 from the routine URL is `send_unconfirmed`, not `not_sent`.** A proxy that times out after the routine started could free the `requestId` and cancel the reply route, so a resend with the same id ran the bot twice. These now report `sent: "unknown"`, keep the id and the route, and point at `wait_reply`.
- Docs: README "Relay mode" section (direct vs relay, variables, read-only, moving a bot to relay and back), variables, endpoints and error tables; `grokbots-send` and `grokbots-roster` skills; manifest variable descriptions.
- Tests: relay success (status-based `list_bots` / `check_bot`, exact `/grokbuild/prompt` body, `delivered` with replies -> `replied`, no `/expect`, no `DELETE`), relay timeout and abort (no `DELETE`, later 404 -> `expired`), relay `requestId` reuse (local and bridge 409; a refused send frees the id), relay gateway 502 -> `send_unconfirmed`, mixed direct + relay, relay fail-fast on an unrouted bot or default (`GROKBOTS_BRIDGE_DEFAULT_BOT` wins over `GROKBOTS_DEFAULT_BOT`), bridge read-only refusal frees the id, and direct-mode gateway 502/503/504 -> `send_unconfirmed` with the route kept (58 tests).
- Bump manifests, MCP package and `VERSION` to `0.1.11`.

## 0.1.10

- **Fix: a `not_sent` result no longer burns a caller-supplied `requestId`.** The id was marked used before the webhook POST, so when the routine refused the prompt (non-2xx or `success: false`) a resend with the same id was refused as `request_id_in_use` although nothing was delivered. The id is now released on `not_sent`; it stays used on success and on `send_unconfirmed` (the bot may have it).
- The set of used `requestId`s is bounded at 1000 entries, oldest dropped first, like the known-routes map (the bridge's 409 still guards an id whose route is open).
- README: use the latest grok-bot-universal-bridge release; `untilReply` blocking, a caller-supplied `requestId` and `request_id_in_use` need 0.2.5 or later.
- Tests: `not_sent` frees the id and a resend goes through (404 and `success: false`); `send_unconfirmed` keeps it and a resend is refused; the used-id cap evicts oldest first and a re-mark refreshes (51 tests).
- Bump manifests, MCP package and `VERSION` to `0.1.10`.

## 0.1.9

- **Fix: `untilReply` blocks without a `progressToken`.** Headless hosts send no progress token, and `send_prompt(confirm: true, untilReply: true)` returned at once with no `waitResult`: the send only waited with `wait: true`, and the wait loop ran past one check-in only when the host asked for progress. Now `untilReply` or `timeoutSec` on `send_prompt` asks for a wait (unless `wait: false`), and `untilReply` polls in check-ins until `replied` / `expired` / `cancelled` / host abort or `GROKBOTS_WAIT_MAX_SEC` (or `timeoutSec` if larger), with or without a token. Progress notifications are still sent when a token is present. The `untilReply: "limited: …"` note is gone.
- A requested wait always returns `waitResult`: `awaiting_reply` / `aborted` (`done: false`, `next: wait_reply`), `not_sent` when the routine refused the prompt (route cancelled), `send_unconfirmed` when the send could not be confirmed (route kept). Abort still stops polling and keeps the route.
- Docs: README, `grokbots-send`, tool schema text and the `GROKBOTS_WAIT_MAX_SEC` manifest description no longer say waiting needs a `progressToken`.
- Tests: stdio `send_prompt untilReply` with no `progressToken` against a fake bridge whose reply lands after ~3 s returns `replied` / `pong` (fails on 0.1.8: no `waitResult`); `waitResult` on timeout, abort and refused send; `wait: false` wins.
- **Caller-supplied `requestId` on `send_prompt`** (8-64 of `A-Z a-z 0-9 _ -`). A host tool-call timeout during a blocking send no longer loses the id after delivery: pass your own and resume with `wait_reply`. A reused id is refused (`request_id_in_use`, nothing sent) when this process already sent it or the bridge still has its route open (409). The first progress update after a send names the `requestId`; each confirmed send logs `grokbots: send_prompt to <bot>, requestId <id>` to stderr (no secrets). Skill, schema and README say: after a host timeout, don't resend, resume with `wait_reply`.
- `not_sent` note no longer claims the cancel happened; it points at `reply.cancelled`.
- Tests: host timeout (1.5 s client timeout) over stdio, then `wait_reply` with the caller's id gets the reply and a resend is refused (one bot run); requestId validation and reuse (local and bridge 409); `send_unconfirmed` (dropped webhook: `done: false`, `next: wait_reply`, no read, no cancel); first progress update names the id (49 tests). README no longer hard-codes a test count.
- Bump manifests, MCP package and `VERSION` to `0.1.9`.

## 0.1.8

- Test: aborting an `untilReply` wait over stdio must also end the in-flight bridge long-poll (the bridge sees the connection close within 3 s, no new read). It fails if only the fetch-level abort link in `call()` is dropped, which the earlier tests did not catch (44 tests).
- README: an abort stops polling, the in-flight request and progress, but deliberately keeps the reply route (never DELETEs it), so a late reply still lands and the next `wait_reply` picks it up.
- `grokbots-send`: the "Bot is not ready" causes are examples ("for example"), not a complete list.
- Bump manifests, MCP package and `VERSION` to `0.1.8`.

## 0.1.7

- **Waiting works like a Discord thread: no short time limit.** One `wait_reply` (or `send_prompt` `wait: true`) call is a check-in, not a time limit. With no reply yet it returns `state: "awaiting_reply"`, `done: false` (not an MCP error) with `requestId`, `elapsedSec` (since the send, from the bridge's `createdAt`), `waitingFor` ("still waiting, 12 min"), `expiresAt`, `next: {tool: "wait_reply", arguments: {requestId}}` and an instruction to post a short progress line and call again. Nothing expires before the bridge's token TTL (6 h by default from bridge 0.2.2).
- Results now carry `done` and a final `state`: `replied`, `expired`, or `cancelled` (bridge 404: cancelled, swept or another client's id). Bridge unreachable stays `done: false`.
- New `untilReply: true`: keeps waiting inside one call while the host takes MCP progress notifications (`progressToken`), sending one per long-poll (at most every 25 s), up to `GROKBOTS_WAIT_MAX_SEC` (default 300 s, max 3600). Without a `progressToken` it waits one check-in and says so.
- New optional variables `GROKBOTS_WAIT_SEC` (check-in interval, default 45, 5-600) and `GROKBOTS_WAIT_MAX_SEC`, declared in all manifests and passed through. Per-call `timeoutSec` max raised from 120 to 600 for hosts that allow long calls.
- Docs: README replies section (check-ins, states, untilReply, new variables, 6 h TTL); `grokbots-send` step 6: "keep calling wait_reply until replied/expired/cancelled; post a short progress note to the user each check"; `grokbots-routine-setup`: token lives until the bridge TTL, take as long as needed.
- Tests: heartbeat shape and a late reply, `cancelled` on 404, `untilReply` with and without progress, MCP progress over stdio, env parsing and labels, and the missing case: no cancel when the webhook connection dies after the POST (`sent: "unknown"`) (43 tests).
- Cancelling a wait stops it: the MCP request's abort signal is passed through `handleTool` → `runWait` → `waitReply` → `fetch`, so polling, the 2 s sleep and progress stop at once (`state: "aborted"`, route kept so `wait_reply` can resume).
- Progress is throttled to at most once per ~25 s, also when the bridge answers at once (busy or long-poll off).
- A bridge 404 is no longer always `cancelled`: `expired` when the last known `expiresAt` has passed, `cancelled` when the route was seen before, `not_found` with a `GROKBOTS_BRIDGE_URL` hint otherwise. Bridge tombstone states (`expired` / `cancelled`, 0.2.3+) end the wait directly. A 401 is final: `config_error` with a `GROKBOTS_BRIDGE_KEY` hint.
- Bump manifests, MCP package and `VERSION` to `0.1.7`.

## 0.1.6

- Bridge URLs are joined with `URL`, so a `GROKBOTS_BRIDGE_URL` with a path prefix (`https://bridge.example.com/base`) works for every call, and the dry-run `reply.url` preview is built correctly (base path redacted like other URLs).
- If the webhook POST fails after the bridge issued a reply route (refused before sending, non-2xx, or `success: false`), `send_prompt` cancels it (`DELETE /grokbuild/requests/<id>`, best effort, needs bridge 0.2.1) and reports `reply: {expected: false, cancelled}`. Not on `sent: "unknown"` or `webhook_response_read_failed`.
- Default wait lowered from 60 s to 45 s for `wait: true` and `wait_reply`, to fit common MCP tool-call timeouts; docs say hosts may time out sooner and suggest `wait_reply` in a loop.
- README: the reply token appears in the bot's routine run history; acceptable because it is single-use with a 15-minute TTL. Same note in `grokbots-routine-setup`.
- Tests: path-prefix joining and preview, cancel on a refused webhook (and none on success), default wait (34 tests).
- Bump manifests, MCP package and `VERSION` to `0.1.6`.

## 0.1.5

- **Replies through an optional bridge.** New user-level variables `GROKBOTS_BRIDGE_URL` / `GROKBOTS_BRIDGE_KEY` (declared in all three manifests and passed through `.mcp.json` / `mcp.json`). With both set, a confirmed `send_prompt` first asks the bridge's GrokBuild adapter (`POST /grokbuild/expect`, grok-bot-universal-bridge 0.2.0+) for a one-time reply token scoped to its `requestId`, then adds `reply: {url, requestId, token, expiresAt, how}` to the webhook body. If the bridge refuses, nothing is sent (`errorCode: "bridge_*"`). The bridge key never goes in a payload, and the reply token never appears in tool output (the dry-run shows a placeholder).
- New read tool `wait_reply(requestId, timeoutSec)`: long-polls `GET /grokbuild/requests/<id>?waitSec=N` (default 60 s, max 120 s) and returns the reply text. `send_prompt` gains `wait` (wait in the same call), `timeoutSec` and `expectReply` (default on when the bridge is set; `false` sends one-way). Without the bridge variables nothing changes.
- `describe_boundary` reports the bridge status (redacted URL, no key).
- README: new **Replies (optional bridge)** section in the single-source setup, new variables, endpoints and `bridge_*` errors. Skills: `grokbots-send` step 6 (read the reply) and bridge errors; `grokbots-routine-setup` adds the generic reply instruction to the routine prompt, the bridge URL allowlist, and a placeholder curl example.
- Tests: `test/reply.test.ts` runs a loopback fake bridge and a fake routine that answers on `reply.url`; `send_prompt` + `wait_reply` and `wait: true` receive the reply (31 tests).
- Bump manifests, MCP package and `VERSION` to `0.1.5`.

## 0.1.4

- `grokbots-send` result guide corrected against `roster.ts` / `tools.ts`: an invalid or missing key is caught when the roster loads and comes back as "Bot is not ready. Nothing sent." with `problems` and `sent: false` (also on the dry-run), not as `webhook_key_invalid`. Added "Key not available. Nothing sent.", the later invalid-key check (code in `errorCode`, not `error`), the other pre-send refusals, and HTTP 200 with `success: false`.
- `wake_bot` / `send_prompt` tool descriptions show the full payload (`from`, `sentAt`, `requestId`, and `replyHint?` for prompts). No behavior change.
- Bump manifests, MCP package and `VERSION` to `0.1.4`.

## 0.1.3

Docs and skills only; no code changes.

- README: new **Webhook and wake setup (single source)** section. This repo is the one place for caller-side webhook setup: user-level `GROKBOTS_WEBHOOK_URL` / `GROKBOTS_WEBHOOK_KEY` / `GROKBOTS_DEFAULT_BOT` or a roster file outside any repo, the key copied from the bot's routine webhook panel (the bot never sees it), lookup order, and that one webhook routine can serve both Discord wakes and GrokBuild prompts (cross-link to grokbot-discord-fleet).
- `grokbots-roster` checked against `roster.ts` / `tools.ts`: added lookup order (env bot first, then file order; later duplicate names ignored), `url` over `urlEnv` and `keyEnv` over `keyFile` precedence, `~/` expansion and the relative-path caveat, name rules (lowercased, max 63 chars), the `{"bots": [...]}` shape, the undeclared `GROKBOTS_DEFAULT_BOT_DESCRIPTION`, and that the roster file is re-read on every call (env changes need a restart; it used to say any change needs a reload).
- `grokbots-send`: `wake_bot` payload corrected (it said only `{kind, reason}`; it also sends `bot`, `from`, `sentAt`, `requestId`); result codes updated to the 0.1.1/0.1.2 `error` / `sent` values (it said "status 0 = network or timeout").
- `grokbots-routine-setup`: exact headers (incl. `Content-Type` and User-Agent) and body fields; how to reuse a Discord wake-on-sleep routine for GrokBuild prompts (tell bodies apart by `kind`).
- Bump manifests, MCP package and `VERSION` to `0.1.3`.

## 0.1.2

- New error code `webhook_response_read_failed` (`sent: true`, `httpStatus` kept) when the routine answers but reading its reply body fails. It used to return `webhook_timeout` / `webhook_network_error` with `sent: true`, which contradicted the README table where those codes mean "no response" (`sent: "unknown"`). Test added; README error table and the tool's not-accepted note updated.
- `tsx` moved to `devDependencies` (only the `dev` and `test` scripts use it). The bootstrap scripts now run `npm ci --omit=dev`, so a plugin install no longer installs `tsx` / `esbuild` and runs no package install scripts. `typescript` and `@types/node` stay in `dependencies` because the bootstrap builds with `tsc`.
- README "Install scripts" note rewritten to match: nothing the bootstrap installs declares an install script (`npm query` prints `[]`).
- `npm audit`: 0 vulnerabilities. Bump manifests, MCP package and `VERSION` to `0.1.2`.

## 0.1.1

- `sent` is now `"unknown"` (was `true`) when the POST throws with no HTTP response (`webhook_timeout`, `webhook_network_error`), because the request may or may not have reached the routine. A key refused before the request is still `sent: false`; any HTTP response is still `sent: true`. New `SentState` type; README error table added.
- POST bodies carry an optional `bot` field: the roster entry name the call was sent as, so a routine shared by several entries can tell them apart. Name only, nothing secret.
- README: accurate install-script note. The plugin has none; `esbuild` (via `tsx`, used for the dev and test scripts) declares a `postinstall` that the bootstrap `npm ci` may run, depending on the npm version.
- `npm audit fix` (lockfile only, no `--force`): `body-parser` 2.3.0 → 2.4.0, `fast-uri` 3.1.8 → 3.1.9, `ip-address` 10.7.2 → 10.7.5, `qs` 6.16.0 → 6.17.0, `zod` 4.6.5 → 4.6.7. `npm audit` now reports 0 vulnerabilities.

## 0.1.0

- First release, split out of `grokbot-discord-fleet` 0.3.33 (generic Grok Build → Grok Bot piece only; no Discord gateway, bridge, callback or REST tools).
- One stdio MCP server, `grokbots`: `list_bots`, `check_bot`, `describe_boundary` (read, no network) and `wake_bot`, `send_prompt` (one webhook-routine POST each, dry-run unless `confirm=true`).
- Roster: env bot (`GROKBOTS_WEBHOOK_URL` / `GROKBOTS_WEBHOOK_KEY`) plus optional `GROKBOTS_ROSTER_FILE` with `keyFile` / `keyEnv` (inline keys rejected). https only (loopback http for tests); URLs redacted in output; keys never returned.
- `GROKBOTS_READ_ONLY` read-only mode, fail-closed (reused from discord-fleet 0.3.33).
- Skills: `grokbots-send`, `grokbots-roster`, `grokbots-routine-setup`.
- Errors are fixed codes or fixed messages, never raw fetch / fs / JSON.parse text (which can quote a key). Keys must be printable ASCII with no spaces or line breaks; others are refused before sending. Invalid roster names and `keyEnv` / `urlEnv` values are not echoed.
- Manifests for Grok Build (`.grok-plugin/plugin.json`, `.mcp.json`), root `plugin.json`, and Cursor (`.cursor-plugin/plugin.json`, `mcp.json`); bootstrap scripts; CI on Linux and Windows.
