# Changelog

## 0.1.0

- First release, split out of `grokbot-discord-fleet` 0.3.33 (generic Grok Build → Grok Bot piece only; no Discord gateway, bridge, callback or REST tools).
- One stdio MCP server, `grokbots`: `list_bots`, `check_bot`, `describe_boundary` (read, no network) and `wake_bot`, `send_prompt` (one webhook-routine POST each, dry-run unless `confirm=true`).
- Roster: env bot (`GROKBOTS_WEBHOOK_URL` / `GROKBOTS_WEBHOOK_KEY`) plus optional `GROKBOTS_ROSTER_FILE` with `keyFile` / `keyEnv` (inline keys rejected). https only (loopback http for tests); URLs redacted in output; keys never returned.
- `GROKBOTS_READ_ONLY` read-only mode, fail-closed (reused from discord-fleet 0.3.33).
- Skills: `grokbots-send`, `grokbots-roster`, `grokbots-routine-setup`.
- Errors are fixed codes or fixed messages, never raw fetch / fs / JSON.parse text (which can quote a key). Keys must be printable ASCII with no spaces or line breaks; others are refused before sending. Invalid roster names and `keyEnv` / `urlEnv` values are not echoed.
- Manifests for Grok Build (`.grok-plugin/plugin.json`, `.mcp.json`), root `plugin.json`, and Cursor (`.cursor-plugin/plugin.json`, `mcp.json`); bootstrap scripts; CI on Linux and Windows.
