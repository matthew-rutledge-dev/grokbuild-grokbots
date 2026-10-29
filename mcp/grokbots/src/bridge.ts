/**
 * Optional reply path through a grok-bot-universal-bridge GrokBuild adapter.
 *
 *   POST <bridge>/grokbuild/expect          client key -> { replyUrl, replyToken, expiresAt }
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
export const MAX_WAIT_SEC = 120;
export const DEFAULT_WAIT_SEC = 60;

export type BridgeConfig = { url?: string; key?: string; problems: string[]; configured: boolean };

export type BridgeErrorCode =
  | "bridge_not_configured"
  | "bridge_key_invalid"
  | "bridge_timeout"
  | "bridge_network_error"
  | "bridge_bad_response"
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

type CallResult = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; error: BridgeErrorCode; detail?: string };

async function call(b: BridgeConfig, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<CallResult> {
  if (!b.configured) return { ok: false, status: 0, error: "bridge_not_configured" };
  if (b.problems.length) return { ok: false, status: 0, error: b.problems.some((p) => p.startsWith(BRIDGE_KEY_ENV)) ? "bridge_key_invalid" : "bridge_not_configured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${b.url}${path}`, {
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
    return { ok: false, status: 0, error: webhookErrorCode(e) === "webhook_timeout" ? "bridge_timeout" : "bridge_network_error" };
  } finally {
    clearTimeout(timer);
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

export type Reply = { content: string; at?: string };
export type WaitResult =
  | { ok: true; requestId: string; state: string; replies: Reply[]; waitedSec: number }
  | { ok: false; requestId: string; error: BridgeErrorCode; status: number; detail?: string; waitedSec: number };

/**
 * Long-poll the bridge until the first reply, the reply route expires, or timeoutSec.
 * ok:true with replies:[] means nothing arrived in time (state says why).
 */
export async function waitReply(b: BridgeConfig, requestId: string, timeoutSec: number, pollSec = POLL_SEC): Promise<WaitResult> {
  const start = Date.now();
  const deadline = start + Math.max(0, timeoutSec) * 1000;
  const waited = () => Math.round((Date.now() - start) / 1000);
  let state = "unknown";
  for (;;) {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const w = Math.min(pollSec, remaining);
    const t0 = Date.now();
    const r = await call(b, "GET", `/grokbuild/requests/${encodeURIComponent(requestId)}?waitSec=${w}`, undefined, (w + 10) * 1000);
    if (!r.ok) return { ok: false, requestId, error: r.error, status: r.status, detail: r.detail, waitedSec: waited() };
    state = typeof r.body.state === "string" ? r.body.state : "unknown";
    const replies = Array.isArray(r.body.replies)
      ? (r.body.replies as unknown[])
          .filter((x): x is { content: string; at?: unknown } => typeof (x as { content?: unknown })?.content === "string")
          .map((x) => ({ content: x.content, at: typeof x.at === "string" ? x.at : undefined }))
      : [];
    if (replies.length) return { ok: true, requestId, state, replies, waitedSec: waited() };
    if (state === "expired" || state === "failed" || Date.now() >= deadline) return { ok: true, requestId, state, replies: [], waitedSec: waited() };
    // A bridge with long-poll off (maxWaitSec 0) answers at once: poll every 2 s instead of spinning.
    if (Date.now() - t0 < 1000) await new Promise((res) => setTimeout(res, Math.min(2000, Math.max(0, deadline - Date.now()))));
  }
}
