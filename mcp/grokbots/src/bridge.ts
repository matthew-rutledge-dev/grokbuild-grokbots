/**
 * Optional reply path through a grok-bot-universal-bridge GrokBuild adapter.
 *
 * Direct mode (this caller posts to the bot's webhook routine itself):
 *   POST <bridge>/grokbuild/expect          client key -> { replyUrl, replyToken, expiresAt }
 * Relay mode (no webhook for the bot here; the bridge delivers):
 *   POST <bridge>/grokbuild/prompt          client key -> { requestId, state }
 *   GET  <bridge>/grokbuild/status          client key -> { bots[], readOnly, replyChannel }
 * Both:
 *   GET  <bridge>/grokbuild/requests/<id>?waitSec=N   client key -> { state, replies[] }
 *
 * The client key (GROKBOTS_BRIDGE_KEY) only ever goes in the Authorization header
 * to the bridge. The bot gets a one-time reply token scoped to one requestId,
 * never this key. Errors are fixed codes; raw fetch error text is never returned.
 */
import { readEnv } from "./env.js";
import { checkUrl, redactUrl } from "./roster.js";
import { USER_AGENT } from "./version.js";
import { KEY_RE, webhookErrorCode } from "./webhook.js";

export const BRIDGE_URL_ENV = "GROKBOTS_BRIDGE_URL";
export const BRIDGE_KEY_ENV = "GROKBOTS_BRIDGE_KEY";
/** Longest single long-poll asked of the bridge (its maxWaitSec default is 25). */
export const POLL_SEC = 25;
export const WAIT_SEC_ENV = "GROKBOTS_WAIT_SEC";
export const WAIT_MAX_SEC_ENV = "GROKBOTS_WAIT_MAX_SEC";
/**
 * One call's wait is a check-in interval, not a time limit: the reply route lives for
 * the bridge's token TTL (6 h by default) and the caller calls wait_reply again.
 * 45 s fits under common MCP tool-call timeouts (often about 60 s).
 */
export const DEFAULT_WAIT_SEC = 45;
/** Largest per-call wait a caller may ask for (only for hosts known to allow long tool calls). */
export const MAX_WAIT_SEC = 600;
/** untilReply: how long one call may keep waiting, with or without progress notifications (default / hard cap). */
export const DEFAULT_UNTIL_REPLY_SEC = 300;
export const MAX_UNTIL_REPLY_SEC = 3600;

function intEnv(name: string, env: NodeJS.ProcessEnv, def: number, min: number, max: number): number {
  const raw = readEnv(name, env);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** Per-call check-in interval: GROKBOTS_WAIT_SEC (5-600), default 45. */
export function checkInSec(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(WAIT_SEC_ENV, env, DEFAULT_WAIT_SEC, 5, MAX_WAIT_SEC);
}

/** untilReply budget for one call: GROKBOTS_WAIT_MAX_SEC (30-3600), default 300. */
export function untilReplySec(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(WAIT_MAX_SEC_ENV, env, DEFAULT_UNTIL_REPLY_SEC, 30, MAX_UNTIL_REPLY_SEC);
}

/** "still waiting, 3 min" style label. */
export function waitingFor(sec: number): string {
  if (sec < 60) return `still waiting, ${Math.max(0, Math.round(sec))} s`;
  if (sec < 3600) return `still waiting, ${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `still waiting, ${h} h${m ? ` ${m} min` : ""}`;
}

export type BridgeConfig = { url?: string; key?: string; problems: string[]; configured: boolean };

export type BridgeErrorCode =
  | "bridge_not_configured"
  | "bridge_key_invalid"
  | "bridge_timeout"
  | "bridge_network_error"
  | "bridge_bad_response"
  | "aborted"
  | `bridge_http_${number}`;

export function loadBridge(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const url = readEnv(BRIDGE_URL_ENV, env)?.replace(/\/+$/, "");
  const key = readEnv(BRIDGE_KEY_ENV, env);
  if (!url && !key) return { problems: [], configured: false };
  const problems = checkUrl(url).map((p) => p.replace("webhook URL", `${BRIDGE_URL_ENV}`));
  if (!key) problems.push(`${BRIDGE_KEY_ENV} not set`);
  else if (!KEY_RE.test(key)) problems.push(`${BRIDGE_KEY_ENV} is not valid (printable ASCII only, no spaces or line breaks)`);
  return { url, key, problems, configured: true };
}

/** Safe summary for tool output: never the key, never the full URL path. */
export function publicBridge(b: BridgeConfig) {
  return { configured: b.configured, target: redactUrl(b.url), ready: b.configured && b.problems.length === 0, problems: b.problems };
}

/** Join a bridge path onto the base URL, keeping any path prefix (https://bridge.example.com/base + grokbuild/x). */
export function bridgeUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), base.endsWith("/") ? base : `${base}/`).toString();
}

/** Where the bridge's reply route is expected, for the dry-run preview only (base path redacted like redactUrl). */
export function replyUrlPreview(b: BridgeConfig): string | undefined {
  if (!b.url) return undefined;
  try {
    const u = new URL(bridgeUrl(b.url, "grokbuild/reply"));
    const segs = u.pathname.split("/").filter(Boolean);
    const prefix = segs.slice(0, -2);
    const shown = prefix.length ? prefix.slice(0, -1).concat("…") : [];
    return `${u.protocol}//${u.host}/${[...shown, "grokbuild", "reply"].join("/")}`;
  } catch {
    return undefined;
  }
}

type CallResult = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; error: BridgeErrorCode; detail?: string };

async function call(
  b: BridgeConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CallResult> {
  if (!b.configured) return { ok: false, status: 0, error: "bridge_not_configured" };
  if (b.problems.length) return { ok: false, status: 0, error: b.problems.some((p) => p.startsWith(BRIDGE_KEY_ENV)) ? "bridge_key_invalid" : "bridge_not_configured" };
  if (signal?.aborted) return { ok: false, status: 0, error: "aborted" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // The caller's abort (the host cancelled the tool call) ends the request at once.
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(bridgeUrl(b.url as string, path), {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${b.key}`, "User-Agent": USER_AGENT },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      redirect: "error",
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse((await res.text()).slice(0, 200_000)) as Record<string, unknown>;
    } catch {
      return { ok: false, status: res.status, error: "bridge_bad_response" };
    }
    if (!res.ok) {
      // The bridge answers fixed error strings (e.g. read_only, unauthorized); cap it anyway.
      const detail = typeof parsed.error === "string" ? parsed.error.slice(0, 80) : undefined;
      return { ok: false, status: res.status, error: `bridge_http_${res.status}`, detail };
    }
    return { ok: true, status: res.status, body: parsed };
  } catch (e) {
    if (signal?.aborted) return { ok: false, status: 0, error: "aborted" };
    return { ok: false, status: 0, error: webhookErrorCode(e) === "webhook_timeout" ? "bridge_timeout" : "bridge_network_error" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export type ReplyRoute = { url: string; requestId: string; token: string; expiresAt: string };

/** Ask the bridge for a one-time reply route for this requestId. */
export async function expectReply(
  b: BridgeConfig,
  requestId: string,
  bot: string,
): Promise<{ ok: true; route: ReplyRoute } | { ok: false; error: BridgeErrorCode; status: number; detail?: string }> {
  const r = await call(b, "POST", "/grokbuild/expect", { requestId, bot }, 8000);
  if (!r.ok) return r;
  const { replyUrl, replyToken, expiresAt } = r.body;
  if (typeof replyUrl !== "string" || typeof replyToken !== "string" || typeof expiresAt !== "string" || checkUrl(replyUrl).length) {
    return { ok: false, status: r.status, error: "bridge_bad_response" };
  }
  return { ok: true, route: { url: replyUrl, requestId, token: replyToken, expiresAt } };
}

/** Best effort: cancel an open reply route (e.g. the webhook POST failed), so the bridge frees its slot now. */
export async function cancelReply(b: BridgeConfig, requestId: string): Promise<boolean> {
  const r = await call(b, "DELETE", `/grokbuild/requests/${encodeURIComponent(requestId)}`, undefined, 5000);
  return r.ok;
}

/** Bot aliases the bridge accepts (lowercase, as in its registry). Passed through as given, never rewritten. */
export const BRIDGE_BOT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type RelayResult =
  | { ok: true; status: number; requestId: string; state: string }
  | { ok: false; status: number; error: BridgeErrorCode; detail?: string };

/**
 * Relay mode: the bridge delivers the prompt to the bot's routine itself (it holds the
 * routine key), so this caller needs no webhook URL or key.
 *   POST <bridge>/grokbuild/prompt  { bot, prompt, requestId, replyHint? } -> 202 { requestId, state }
 * The bot answers through the bridge's own callback; the reply is read with waitReply.
 * Longer timeout than /expect: the bridge makes its first delivery try before it answers.
 */
export async function relayPrompt(
  b: BridgeConfig,
  msg: { bot: string; prompt: string; requestId: string; replyHint?: string },
  timeoutMs = 20_000,
): Promise<RelayResult> {
  const body: Record<string, string> = { bot: msg.bot, prompt: msg.prompt, requestId: msg.requestId };
  if (msg.replyHint) body.replyHint = msg.replyHint;
  const r = await call(b, "POST", "/grokbuild/prompt", body, timeoutMs);
  if (!r.ok) return r;
  const state = typeof r.body.state === "string" ? r.body.state : "unknown";
  return { ok: true, status: r.status, requestId: typeof r.body.requestId === "string" ? r.body.requestId : msg.requestId, state };
}

export type BridgeStatus =
  | { ok: true; client?: string; readOnly?: boolean; replyChannel?: string; directReplies?: string; bots: string[] }
  | { ok: false; status: number; error: BridgeErrorCode; detail?: string };

/** GET <bridge>/grokbuild/status: which bots this client token is routed to (writes nothing on the bridge). */
export async function bridgeStatus(b: BridgeConfig): Promise<BridgeStatus> {
  const r = await call(b, "GET", "/grokbuild/status", undefined, 8000);
  if (!r.ok) return r;
  const bots = Array.isArray(r.body.bots) ? (r.body.bots as unknown[]).filter((x): x is string => typeof x === "string" && BRIDGE_BOT_RE.test(x)) : [];
  return {
    ok: true,
    client: typeof r.body.client === "string" ? r.body.client : undefined,
    readOnly: typeof r.body.readOnly === "boolean" ? r.body.readOnly : undefined,
    replyChannel: typeof r.body.replyChannel === "string" ? r.body.replyChannel : undefined,
    directReplies: typeof r.body.directReplies === "string" ? r.body.directReplies : undefined,
    bots: [...new Set(bots)],
  };
}

export type Reply = { content: string; at?: string };
export type WaitResult =
  | { ok: true; requestId: string; state: string; replies: Reply[]; waitedSec: number; createdAt?: string; expiresAt?: string }
  | { ok: false; requestId: string; error: BridgeErrorCode; status: number; detail?: string; waitedSec: number; seen?: boolean; expiresAt?: string };

/**
 * Long-poll the bridge until the first reply, the reply route expires, or timeoutSec.
 * ok:true with replies:[] means nothing arrived in time (state says why).
 */
export type WaitTick = { requestId: string; state: string; waitedSec: number; elapsedSec?: number };

/** Progress is sent at most this often, even when the bridge answers at once (busy, or long-poll off). */
export const progressTiming = { everySec: POLL_SEC };

/** Sleep that ends early when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Final states a bridge read can report (0.2.3+ keeps a short tombstone for expired / cancelled). */
const FINAL_STATES = new Set(["expired", "cancelled", "failed"]);

export async function waitReply(
  b: BridgeConfig,
  requestId: string,
  timeoutSec: number,
  opts: { pollSec?: number; onTick?: (t: WaitTick) => void | Promise<void>; signal?: AbortSignal; lastTickAt?: number } = {},
): Promise<WaitResult> {
  const pollSec = opts.pollSec ?? POLL_SEC;
  const signal = opts.signal;
  let lastTick = opts.lastTickAt ?? -Infinity; // the caller may have just sent one
  let seen = false;
  const start = Date.now();
  const deadline = start + Math.max(0, timeoutSec) * 1000;
  const waited = () => Math.round((Date.now() - start) / 1000);
  let state = "unknown";
  let createdAt: string | undefined;
  let expiresAt: string | undefined;
  for (;;) {
    if (signal?.aborted) return { ok: false, requestId, error: "aborted", status: 0, waitedSec: waited() };
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const w = Math.min(pollSec, remaining);
    const t0 = Date.now();
    const r = await call(b, "GET", `/grokbuild/requests/${encodeURIComponent(requestId)}?waitSec=${w}`, undefined, (w + 10) * 1000, signal);
    if (!r.ok) return { ok: false, requestId, error: r.error, status: r.status, detail: r.detail, waitedSec: waited(), seen, ...(expiresAt ? { expiresAt } : {}) };
    seen = true;
    if (signal?.aborted) return { ok: false, requestId, error: "aborted", status: 0, waitedSec: waited() };
    state = typeof r.body.state === "string" ? r.body.state : "unknown";
    if (typeof r.body.createdAt === "string") createdAt = r.body.createdAt;
    if (typeof r.body.expiresAt === "string") expiresAt = r.body.expiresAt;
    const extra = { ...(createdAt ? { createdAt } : {}), ...(expiresAt ? { expiresAt } : {}) };
    const replies = Array.isArray(r.body.replies)
      ? (r.body.replies as unknown[])
          .filter((x): x is { content: string; at?: unknown } => typeof (x as { content?: unknown })?.content === "string")
          .map((x) => ({ content: x.content, at: typeof x.at === "string" ? x.at : undefined }))
      : [];
    if (replies.length) return { ok: true, requestId, state, replies, waitedSec: waited(), ...extra };
    if (FINAL_STATES.has(state) || Date.now() >= deadline) return { ok: true, requestId, state, replies: [], waitedSec: waited(), ...extra };
    if (opts.onTick && Date.now() - lastTick >= progressTiming.everySec * 1000) {
      lastTick = Date.now();
      const created = createdAt ? Date.parse(createdAt) : NaN;
      await opts.onTick({ requestId, state, waitedSec: waited(), ...(Number.isFinite(created) ? { elapsedSec: Math.round((Date.now() - created) / 1000) } : {}) });
    }
    // A bridge with long-poll off (maxWaitSec 0) answers at once: poll every 2 s instead of spinning.
    if (Date.now() - t0 < 1000) await sleep(Math.min(2000, Math.max(0, deadline - Date.now())), signal);
  }
}
