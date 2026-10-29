# Changelog

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
