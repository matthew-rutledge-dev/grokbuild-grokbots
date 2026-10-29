---
name: grokbots-roster
description: Use when the user wants to configure which Grok Bots Grok Build or Cursor can reach. Covers the plugin variables (GROKBOTS_WEBHOOK_URL / GROKBOTS_WEBHOOK_KEY / GROKBOTS_DEFAULT_BOT), the multi-bot roster file, lookup order, or a list_bots result showing "not ready".
---

# Configure the Grok Bot roster (caller side)

Each bot is one webhook-triggered routine with a **POST URL** and a **sender key**, both copied from that routine's webhook panel in the Grok Bot app (see skill `grokbots-routine-setup`). The bot never sees the key. Secrets only live in plugin variables, the user's env vars or key files outside any repo. They never go in git, in chat or inline in the roster file.

## One bot (simplest)

Set the plugin variables (Grok Build / Cursor plugin settings), or user-level env vars in the shell the host starts from. Not a project `.env`.

| Variable | Value |
|---|---|
| `GROKBOTS_WEBHOOK_URL` | the routine's POST URL (https; plain http only to loopback, for tests; no `user:pass@` in the URL) |
| `GROKBOTS_WEBHOOK_KEY` | the routine's sender key (printable ASCII, no spaces or line breaks) |
| `GROKBOTS_DEFAULT_BOT` | optional roster name, e.g. `example-agent` (default `default`; lowercased) |
| `GROKBOTS_SENDER` | optional `from` label, default `grokbuild` (first 64 chars used) |

`GROKBOTS_DEFAULT_BOT_DESCRIPTION` (optional description for the env bot) is also read, but it isn't a declared plugin variable, so it only works if it's in the environment the host passes to the MCP process.

## Several bots

Point `GROKBOTS_ROSTER_FILE` at a JSON file outside any repo. An absolute path or `~/…` works (`~/` is expanded); a relative path resolves against the MCP server's working directory (`mcp/grokbots`), so avoid it.

```json
{
  "bots": [
    { "name": "example-agent", "description": "research bot", "url": "https://example.com/webhook", "keyFile": "~/.config/grokbots/example-agent.key" },
    { "name": "example-helper", "urlEnv": "EXAMPLE_HELPER_URL", "keyEnv": "EXAMPLE_HELPER_KEY" }
  ]
}
```

- The top level must be `{"bots": [...]}`.
- **URL:** `url` (literal) wins over `urlEnv` (name of an env var holding the URL) if both are set.
- **Key:** `keyEnv` wins over `keyFile` if both are set. `keyFile` (recommended) is a file holding only the key; surrounding whitespace is trimmed and `~/` is expanded. Create it with `umask 077`, so it's mode 0600, and keep it out of git.
- `keyEnv` / `urlEnv` must be valid env var names, and only work if the host passes that variable through to the MCP process. Many hosts only pass the declared plugin variables, so prefer `keyFile`.
- The key from `keyEnv` / `keyFile` is sent to that entry's URL on every confirmed call, so only pair a key with a URL you trust.
- An inline `"key"` is rejected. Names are lowercased, must start with a letter or digit, use only `a-z 0-9 . _ -` and be at most 63 characters; an invalid name skips the entry. `description` is cut to 200 characters.

## Lookup order

1. The env bot, if `GROKBOTS_WEBHOOK_URL` or `GROKBOTS_WEBHOOK_KEY` is set (named `GROKBOTS_DEFAULT_BOT`, default `default`).
2. Then the roster file entries, in file order.
3. A later entry whose name is already taken is ignored and reported in `errors`.

`wake_bot` / `send_prompt` / `check_bot` take `bot` (the name). It can be left out only when exactly one bot is configured.

Values like `${GROKBOTS_WEBHOOK_URL}` that a host passes through unexpanded, and empty values, count as unset.

## Which tools read it

`list_bots`, `check_bot`, `wake_bot` and `send_prompt` load the roster fresh on every call. Edits to the roster file or a key file apply on the next call. Changes to plugin variables or env vars need a host restart or reload, because the MCP process only gets its environment at start. Keys are read only to check they're present and valid and, for a confirmed send, to set the headers. No tool returns a key or the full URL.

## Verify

`list_bots` should show each bot with `ready: true`, and `check_bot` lists any problems. Then use skill `grokbots-send`.

## Read-only mode

`GROKBOTS_READ_ONLY=1` hides `wake_bot` and `send_prompt`. Any unrecognised non-empty value also turns it on (fails closed). `0` / `false` / `no` / `off` or unset turn it off.
