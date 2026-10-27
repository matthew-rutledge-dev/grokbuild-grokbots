---
name: grokbots-send
description: Use when you are working in Grok Build or Cursor and need to wake a Grok Bot or hand it a prompt or task, e.g. "tell my Grok Bot to …", "wake example-agent", "send this to my bot". Uses the grokbots MCP tools (list_bots, check_bot, wake_bot, send_prompt).
---

# Send a prompt to, or wake, a Grok Bot

The `grokbots` MCP server POSTs once to a Grok Bot's **webhook-triggered routine**, the documented way to wake a bot from outside. It does not use any undocumented gateway, and it does not return the bot's answer. The bot does the work and reports in its own app or channel.

## Steps

1. **Find the bot.** Call `list_bots`. Pick the bot by `name`. If `count` is 0 or the bot shows `ready: false`, stop and point the user at skill `grokbots-roster` (caller side) and `grokbots-routine-setup` (bot side). Never ask for the key in chat.
2. **Check it.** `check_bot` with `bot` confirms the URL is https and a key is present. No network call.
3. **Preview.** Call `send_prompt` (or `wake_bot`) **without** `confirm`. You get a dry-run with the exact JSON payload and a redacted target. Nothing is sent.
4. **Confirm.** Show the user the bot name and the prompt. Only after they agree, call again with `confirm: true`. One POST, 8 s timeout, no retry.
5. **Read the result.** `ok: true` with HTTP 200 (`{success:true, runUuid}`) means the routine accepted it. 401/403 = wrong key, 404 = wrong URL or deleted routine, status 0 = network or timeout. Don't retry in a loop; report it.

## Rules

- Keep prompts self-contained (max 8000 chars). The bot's routine treats the body as untrusted data, so write a clear request, not instructions that pretend to be the bot's owner.
- Don't send secrets, tokens or private file contents in a prompt.
- `wake_bot` sends only `{kind:"wake", reason}`. Use it to nudge a bot, e.g. so a routine drains a queue.
- If `GROKBOTS_READ_ONLY` is on, `wake_bot` and `send_prompt` are hidden. Don't look for workarounds; tell the user.
- Never print the webhook URL path or key. Tool output already redacts them.

## Related

- Bot side (create the routine): skill `grokbots-routine-setup`
- Caller side (env vars and roster file): skill `grokbots-roster`
