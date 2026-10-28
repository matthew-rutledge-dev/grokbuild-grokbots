/**
 * One POST to a Grok Bot webhook-triggered routine (the documented wake path).
 * Headers: Authorization: Bearer <key> and X-Automation-Key: <key>.
 * 8 s timeout, one try, no retry. The key is never logged or returned.
 *
 * Errors are fixed codes only. Raw fetch/network error text is never returned,
 * because it can quote header values (and so the key).
 *
 * `sent` says whether the routine got the request:
 *   false     nothing went out (key refused before fetch)
 *   true      an HTTP response came back, so the request arrived
 *   "unknown" fetch threw (network error, timeout, refused redirect); the request
 *             may or may not have reached the routine, so do not assume either way
 */
import { USER_AGENT } from "./version.js";

export type WebhookErrorCode =
  | "webhook_key_invalid"
  | "webhook_timeout"
  | "webhook_network_error"
  | `webhook_http_${number}`;

/** Whether the request reached the routine. "unknown" when fetch threw after it may have gone out. */
export type SentState = boolean | "unknown";

export type PostResult = { ok: boolean; status: number; body: unknown; error?: WebhookErrorCode; sent: SentState };

/** Printable ASCII, no spaces, no line breaks or other control characters. */
export const KEY_RE = /^[\x21-\x7e]+$/;

export const KEY_INVALID_MESSAGE =
  "webhook key is not valid (printable ASCII only, no spaces or line breaks). Nothing sent.";

export function isValidKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

/** Map any thrown fetch error to a fixed code. Never reads or returns err.message. */
export function webhookErrorCode(e: unknown): WebhookErrorCode {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return "webhook_timeout";
  return "webhook_network_error";
}

export async function postWebhook(url: string, key: string, payload: unknown, timeoutMs = 8000): Promise<PostResult> {
  if (!isValidKey(key)) return { ok: false, status: 0, body: null, error: "webhook_key_invalid", sent: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "X-Automation-Key": key,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      redirect: "error",
    });
    let text = "";
    try {
      text = (await res.text()).slice(0, 2000);
    } catch (e) {
      return { ok: false, status: res.status, body: null, error: webhookErrorCode(e), sent: true };
    }
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return res.ok
      ? { ok: true, status: res.status, body, sent: true }
      : { ok: false, status: res.status, body, error: `webhook_http_${res.status}`, sent: true };
  } catch (e) {
    // No HTTP response. The request may already have gone out (e.g. a timeout after
    // the body was written), so report "unknown" rather than claiming either way.
    return { ok: false, status: 0, body: null, error: webhookErrorCode(e), sent: "unknown" };
  } finally {
    clearTimeout(timer);
  }
}
