/**
 * One POST to a Grok Bot webhook-triggered routine (the documented wake path).
 * Headers: Authorization: Bearer <key> and X-Automation-Key: <key>.
 * 8 s timeout, one try, no retry. The key is never logged or returned.
 */
import { USER_AGENT } from "./version.js";

export type PostResult = { ok: boolean; status: number; body: unknown; error?: string };

export async function postWebhook(url: string, key: string, payload: unknown, timeoutMs = 8000): Promise<PostResult> {
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
    const text = (await res.text()).slice(0, 2000);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    const err = e as Error;
    return { ok: false, status: 0, body: null, error: err.name === "AbortError" ? "timeout after 8s" : err.message };
  } finally {
    clearTimeout(timer);
  }
}
