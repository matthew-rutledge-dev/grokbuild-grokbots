---
name: grokbots-roster
description: Use when the user wants to configure which Grok Bots Grok Build or Cursor can reach. Covers the plugin variables (GROKBOTS_WEBHOOK_URL / GROKBOTS_WEBHOOK_KEY), the multi-bot roster file, or a list_bots result showing "not ready".
---

# Configure the Grok Bot roster (caller side)

Each bot is one webhook-triggered routine with a **POST URL** and a **sender key**, both copied from that routine's panel in the Grok Bot app (see skill `grokbots-routine-setup`). Secrets only live in plugin variables, env vars or key files. They never go in git, in chat or inline in the roster file.

## One bot (simplest)

Set the plugin variables (Grok Build / Cursor plugin settings, or the shell env the host starts from):

| Variable | Value |
|---|---|
| `GROKBOTS_WEBHOOK_URL` | the routine's POST URL (https) |
| `GROKBOTS_WEBHOOK_KEY` | the routine's sender key |
| `GROKBOTS_DEFAULT_BOT` | optional roster name, e.g. `example-agent` (default `default`) |
| `GROKBOTS_SENDER` | optional "from" label, default `grokbuild` |

## Several bots

Point `GROKBOTS_ROSTER_FILE` at a JSON file outside any repo:

```json
{
  "bots": [
    { "name": "example-agent", "description": "research bot", "url": "https://example.com/webhook", "keyFile": "~/.config/grokbots/example-agent.key" },
    { "name": "example-helper", "urlEnv": "EXAMPLE_HELPER_URL", "keyEnv": "EXAMPLE_HELPER_KEY" }
  ]
}
```

- `keyFile` (recommended): a file holding only the key. Create it with `umask 077`, so it's mode 0600, and keep it out of git.
- The key from `keyEnv` / `keyFile` is sent to that entry's URL on every confirmed call, so only pair a key with a URL you trust.
- `keyEnv` / `urlEnv`: only work if the host passes that variable through to the MCP process. Many hosts only pass the declared plugin variables, so prefer `keyFile`.
- An inline `"key"` is rejected. Names are lowercase (`a-z 0-9 . _ -`) and must be unique, and the env bot is listed first.

Write the key file without echoing it, e.g. read it from the clipboard or a masked prompt (`read -rs k; printf %s "$k" > file`). Never `cat` it.

## Verify

Restart or reload the host so the MCP server picks up the changes. Then `list_bots` should show each bot with `ready: true`, and `check_bot` lists any problems. Then use skill `grokbots-send`.

## Read-only mode

`GROKBOTS_READ_ONLY=1` hides `wake_bot` and `send_prompt`. Any unrecognised non-empty value also turns it on (fails closed). `0` / `false` / `no` / `off` or unset turn it off.
