/**
 * Tool list and handlers for the grokbots MCP server.
 * Read tools: list_bots, check_bot, describe_boundary (no network).
 * Write tools: wake_bot, send_prompt (one webhook POST each; dry-run unless confirm=true;
 * hidden and refused in read-only mode).
 */
import crypto from "node:crypto";
import { readEnv } from "./env.js";
import { READ_ONLY_ENV, describeReadOnly, type ReadOnlyResolution } from "./readonly.js";
import { jsonResult, type ToolResult } from "./result.js";
import { loadRoster, publicBot, redactUrl, type BotEntry } from "./roster.js";
import { SERVER_NAME, VERSION } from "./version.js";
import { KEY_INVALID_MESSAGE, isValidKey, postWebhook } from "./webhook.js";

export { READ_ONLY_ENV };

export const WRITE_TOOLS = ["wake_bot", "send_prompt"] as const;
export const READ_TOOLS = ["list_bots", "check_bot", "describe_boundary"] as const;
export const MAX_PROMPT_CHARS = 8000;
const MAX_REASON_CHARS = 500;

export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name);
}

const botArg = {
  bot: {
    type: "string",
    description: "Bot name from list_bots. Optional when exactly one bot is configured.",
  },
};
const confirmArg = {
  confirm: {
    type: "boolean",
    description: "Must be true to actually POST. Without it you get a dry-run preview and nothing is sent.",
  },
};

const ALL_TOOLS = [
  {
    name: "list_bots",
    description:
      "List the Grok Bots on this caller's roster (env default bot + optional GROKBOTS_ROSTER_FILE). Shows name, redacted target host, key source and readiness. Never returns keys or full webhook URLs. No network.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_bot",
    description:
      "Validate one bot's config (https URL, key present) without calling it. No network. Use before wake_bot / send_prompt.",
    inputSchema: { type: "object", properties: { ...botArg }, additionalProperties: false },
  },
  {
    name: "describe_boundary",
    description:
      "Explain what this plugin does and does not do: one documented webhook-routine POST per call, confirm-gated, no undocumented gateway, no reply channel. Reports read-only mode.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wake_bot",
    description:
      "Wake a Grok Bot by POSTing a small JSON wake event ({kind:\"wake\", reason}) to its webhook-triggered routine. Dry-run preview unless confirm=true. One try, 8 s timeout. Hidden in read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        ...botArg,
        reason: { type: "string", description: `Short reason shown to the bot (max ${MAX_REASON_CHARS} chars).` },
        ...confirmArg,
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_prompt",
    description:
      `Send a prompt to a Grok Bot through its webhook-triggered routine ({kind:\"prompt\", prompt}). The bot's routine treats it as untrusted data. Dry-run preview unless confirm=true. Max ${MAX_PROMPT_CHARS} chars, one try, 8 s timeout. No reply is returned here; the bot answers in its own app/channel. Hidden in read-only mode.`,
    inputSchema: {
      type: "object",
      properties: {
        ...botArg,
        prompt: { type: "string", description: "The prompt text." },
        replyHint: {
          type: "string",
          description: "Optional short hint for where the bot should report back (e.g. 'reply in your own chat'). Not a URL.",
        },
        ...confirmArg,
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

export function listTools(readOnly: boolean) {
  return readOnly ? ALL_TOOLS.filter((t) => !isWriteTool(t.name)) : ALL_TOOLS;
}

function pickBot(args: Record<string, unknown>): { bot?: BotEntry; error?: string; errors: string[] } {
  const roster = loadRoster();
  const want = typeof args.bot === "string" ? args.bot.trim().toLowerCase() : "";
  if (!want) {
    if (roster.bots.length === 1) return { bot: roster.bots[0], errors: roster.errors };
    return {
      error:
        roster.bots.length === 0
          ? "No bots configured. Set GROKBOTS_WEBHOOK_URL + GROKBOTS_WEBHOOK_KEY, or GROKBOTS_ROSTER_FILE."
          : `Several bots configured; pass bot (one of: ${roster.bots.map((b) => b.name).join(", ")}).`,
      errors: roster.errors,
    };
  }
  const bot = roster.bots.find((b) => b.name === want);
  return bot ? { bot, errors: roster.errors } : { error: `Unknown bot ${JSON.stringify(want)}. Call list_bots.`, errors: roster.errors };
}

function sender(): string {
  return (readEnv("GROKBOTS_SENDER") ?? "grokbuild").slice(0, 64);
}

async function deliver(bot: BotEntry, payload: Record<string, unknown>, confirm: boolean): Promise<ToolResult> {
  const preview = { bot: bot.name, target: redactUrl(bot.url), payload };
  if (bot.problems.length) {
    return jsonResult({ ok: false, sent: false, ...preview, problems: bot.problems, error: "Bot is not ready. Nothing sent." }, true);
  }
  if (!confirm) {
    return jsonResult({
      ok: true,
      dryRun: true,
      sent: false,
      ...preview,
      note: "Dry-run preview only. Re-call with confirm=true to POST once to this bot's webhook routine.",
    });
  }
  const key = bot.readKey();
  if (!key) return jsonResult({ ok: false, sent: false, ...preview, error: "Key not available. Nothing sent." }, true);
  if (!isValidKey(key)) {
    return jsonResult({ ok: false, sent: false, ...preview, errorCode: "webhook_key_invalid", error: KEY_INVALID_MESSAGE }, true);
  }
  const res = await postWebhook(bot.url as string, key, payload);
  const accepted = res.ok && (res.body as { success?: unknown })?.success !== false;
  return jsonResult(
    {
      ok: accepted,
      sent: res.sent,
      bot: bot.name,
      target: redactUrl(bot.url),
      requestId: payload.requestId,
      httpStatus: res.status,
      response: res.body,
      error: res.error,
      note: accepted
        ? "Routine accepted the POST (expect HTTP 200 with {success:true, runUuid}). The bot runs it on its own; no reply comes back here."
        : "Not accepted. webhook_http_401/403 = wrong key or header, webhook_http_404 = wrong URL or deleted routine, webhook_timeout / webhook_network_error = no HTTP response. Not retried.",
    },
    !accepted,
  );
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { readOnly: ReadOnlyResolution },
): Promise<ToolResult | undefined> {
  switch (name) {
    case "list_bots": {
      const r = loadRoster();
      return jsonResult({
        ok: true,
        count: r.bots.length,
        bots: r.bots.map(publicBot),
        rosterFile: r.rosterFile ? "set" : "not set",
        errors: r.errors,
      });
    }
    case "check_bot": {
      const p = pickBot(args);
      if (!p.bot) return jsonResult({ ok: false, error: p.error, rosterErrors: p.errors }, true);
      const pub = publicBot(p.bot);
      return jsonResult({ ok: pub.ready, ...pub, rosterErrors: p.errors, network: "none (config check only)" });
    }
    case "describe_boundary":
      return jsonResult({
        ok: true,
        server: SERVER_NAME,
        version: VERSION,
        readOnly: ctx.readOnly.readOnly,
        readOnlyStatus: describeReadOnly(ctx.readOnly),
        readOnlySource: ctx.readOnly.source,
        wakePath: "Grok Bot webhook-triggered routine (documented). One POST per confirmed call.",
        usesUndocumentedGateway: false,
        headers: ["Authorization: Bearer <key>", "X-Automation-Key: <key>"],
        replies: "none returned; the bot reports in its own app/channel",
        secrets: "keys come from env vars or key files only; never returned or logged",
        readTools: READ_TOOLS,
        writeTools: ctx.readOnly.readOnly ? [] : WRITE_TOOLS,
      });
    case "wake_bot": {
      const p = pickBot(args);
      if (!p.bot) return jsonResult({ ok: false, sent: false, error: p.error, rosterErrors: p.errors }, true);
      const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, MAX_REASON_CHARS) : "";
      const payload = {
        kind: "wake",
        reason: reason || "wake requested",
        from: sender(),
        sentAt: new Date().toISOString(),
        requestId: crypto.randomUUID(),
      };
      return deliver(p.bot, payload, args.confirm === true);
    }
    case "send_prompt": {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return jsonResult({ ok: false, sent: false, error: "prompt is empty. Nothing sent." }, true);
      if (prompt.length > MAX_PROMPT_CHARS) {
        return jsonResult({ ok: false, sent: false, error: `prompt is ${prompt.length} chars; max ${MAX_PROMPT_CHARS}. Nothing sent.` }, true);
      }
      const p = pickBot(args);
      if (!p.bot) return jsonResult({ ok: false, sent: false, error: p.error, rosterErrors: p.errors }, true);
      const replyHint = typeof args.replyHint === "string" ? args.replyHint.trim().slice(0, 200) : undefined;
      const payload: Record<string, unknown> = {
        kind: "prompt",
        prompt,
        from: sender(),
        sentAt: new Date().toISOString(),
        requestId: crypto.randomUUID(),
      };
      if (replyHint) payload.replyHint = replyHint;
      return deliver(p.bot, payload, args.confirm === true);
    }
    default:
      return undefined;
  }
}
