/**
 * Error hardening for the webhook POST: fixed error codes only, never raw fetch
 * error text, and keys with control characters are refused before any send.
 * A loopback mock stands in for the routine; no real webhook is called.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isValidKey, postWebhook, webhookErrorCode } from "../src/webhook.js";

const KEY = "placeholder-key-11111111";

async function server(handler: http.RequestListener) {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/automations/webhook/11111111`,
    hits: () => hits,
    close: () => new Promise<void>((r) => {
      srv.closeAllConnections?.();
      srv.close(() => r());
    }),
  };
}

test("isValidKey: printable ASCII only, no spaces or control characters", () => {
  assert.equal(isValidKey(KEY), true);
  for (const bad of ["", "a b", "line1\nline2", "a\rb", "tab\there", "nul\u0000", "caf\u00e9", "\u007f"]) {
    assert.equal(isValidKey(bad), false, JSON.stringify(bad));
  }
});

test("key with a line break: refused before any request; result never contains the key", async () => {
  const mock = await server((_req, res) => res.end("{}"));
  const badKey = "secret-part-one\nsecret-part-two";
  try {
    const r = await postWebhook(mock.url, badKey, { kind: "wake" });
    assert.equal(r.ok, false);
    assert.equal(r.sent, false);
    assert.equal(r.error, "webhook_key_invalid");
    assert.equal(mock.hits(), 0);
    const out = JSON.stringify(r);
    assert.ok(!out.includes("secret-part-one"));
    assert.ok(!out.includes("secret-part-two"));
  } finally {
    await mock.close();
  }
});

test("network error maps to webhook_network_error, no raw message", async () => {
  const mock = await server((_req, res) => res.end("{}"));
  const url = mock.url;
  await mock.close(); // nothing listening now: connection refused
  const r = await postWebhook(url, KEY, { kind: "wake" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.error, "webhook_network_error");
  assert.equal(r.sent, "unknown");
  const out = JSON.stringify(r);
  assert.ok(!out.includes(KEY));
  assert.ok(!/ECONNREFUSED|fetch failed/i.test(out));
});

test("redirect refused maps to webhook_network_error", async () => {
  const mock = await server((_req, res) => {
    res.writeHead(302, { location: "https://example.invalid/elsewhere" });
    res.end();
  });
  try {
    const r = await postWebhook(mock.url, KEY, { kind: "wake" });
    assert.equal(r.error, "webhook_network_error");
    assert.equal(r.sent, "unknown");
    assert.ok(!JSON.stringify(r).includes(KEY));
  } finally {
    await mock.close();
  }
});

test("timeout maps to webhook_timeout", async () => {
  const mock = await server(() => {
    /* never answer */
  });
  try {
    const r = await postWebhook(mock.url, KEY, { kind: "wake" }, 100);
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.equal(r.error, "webhook_timeout");
    // The request went out before the timeout fired, so "sent" is not knowable.
    assert.equal(r.sent, "unknown");
    assert.equal(mock.hits(), 1);
  } finally {
    await mock.close();
  }
});

test("HTTP error status maps to webhook_http_<status>", async () => {
  const mock = await server((_req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false }));
  });
  try {
    const r = await postWebhook(mock.url, KEY, { kind: "wake" });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.error, "webhook_http_403");
    assert.equal(r.sent, true);
  } finally {
    await mock.close();
  }
});

test("webhookErrorCode never uses the message text", () => {
  const e = new TypeError(`invalid header value Bearer ${KEY}`);
  assert.equal(webhookErrorCode(e), "webhook_network_error");
  assert.equal(webhookErrorCode(Object.assign(new Error(KEY), { name: "AbortError" })), "webhook_timeout");
  assert.equal(webhookErrorCode(undefined), "webhook_network_error");
});

test("body read fails after headers: own code, sent true, status kept, no raw message", async () => {
  const mock = await server((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
    res.write('{"success":tr');
    setTimeout(() => res.socket?.destroy(), 20);
  });
  try {
    const r = await postWebhook(mock.url, KEY, { kind: "wake" });
    assert.equal(r.ok, false);
    assert.equal(r.status, 200);
    assert.equal(r.sent, true);
    assert.equal(r.error, "webhook_response_read_failed");
    assert.equal(r.body, null);
    assert.equal(mock.hits(), 1);
    assert.ok(!JSON.stringify(r).includes(KEY));
  } finally {
    await mock.close();
  }
});
