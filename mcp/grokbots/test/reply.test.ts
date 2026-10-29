/**
 * Reply path through the bridge, on loopback only. A fake bridge implements the
 * GrokBuild adapter's direct-reply API (POST /grokbuild/expect, POST /grokbuild/reply,
 * GET /grokbuild/requests/:id?waitSec=N); a fake webhook routine plays the woken bot
 * and answers on reply.url with the one-time token, like the routine prompt says.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { REPLY_HOW, handleTool } from "../src/tools.js";
import { loadBridge, waitReply } from "../src/bridge.js";

const ROUTINE_KEY = "placeholder-key-11111111";
const BRIDGE_KEY = "placeholder-bridge-client-22222222";
const ro = { readOnly: { readOnly: false, source: "default" } } as never;

type Rec = { token?: string; expires: number; replies: { content: string; at: string }[]; waiters: (() => void)[] };

async function listen(srv: http.Server) {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}
function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((r) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => r(raw ? JSON.parse(raw) : {}));
  });
}

async function fakeBridge(opts: { expectStatus?: number } = {}) {
  const recs = new Map<string, Rec>();
  const seen: { path: string; auth?: string; body?: any }[] = [];
  let base = "";
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const body = req.method === "POST" ? await readJson(req) : undefined;
    seen.push({ path: url.pathname, auth: req.headers.authorization, body });
    const client = req.headers.authorization === `Bearer ${BRIDGE_KEY}`;
    if (url.pathname === "/grokbuild/expect") {
      if (!client) return send(401, { ok: false, error: "unauthorized" });
      if (opts.expectStatus) return send(opts.expectStatus, { ok: false, error: "read_only" });
      const token = crypto.randomBytes(32).toString("base64url");
      recs.set(body.requestId, { token, expires: Date.now() + 60_000, replies: [], waiters: [] });
      return send(201, { ok: true, requestId: body.requestId, replyUrl: `${base}/grokbuild/reply`, replyToken: token, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname === "/grokbuild/reply") {
      const r = recs.get(body?.requestId);
      if (!r || !r.token || req.headers.authorization !== `Bearer ${r.token}`) return send(401, { ok: false, error: "unauthorized" });
      r.replies.push({ content: body.content, at: new Date().toISOString() });
      delete r.token;
      for (const w of r.waiters.splice(0)) w();
      return send(200, { ok: true });
    }
    const m = /^\/grokbuild\/requests\/([^/]+)$/.exec(url.pathname);
    if (m) {
      if (!client) return send(401, { ok: false, error: "unauthorized" });
      const r = recs.get(m[1]);
      if (!r) return send(404, { ok: false, error: "not_found" });
      const wait = Math.min(Number(url.searchParams.get("waitSec") ?? 0), 25);
      if (!r.replies.length && wait > 0) await new Promise<void>((done) => { r.waiters.push(done); setTimeout(done, wait * 1000); });
      return send(200, { ok: true, requestId: m[1], state: r.replies.length ? "replied" : "awaiting_reply", replies: r.replies });
    }
    send(404, { ok: false, error: "not_found" });
  });
  base = await listen(srv);
  return { url: base, seen, recs, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
}

/** The webhook routine + woken bot: 200 to the webhook, then (optionally) a reply on reply.url. */
async function fakeRoutine(answer: string | undefined, delayMs = 150) {
  const hits: any[] = [];
  const srv = http.createServer(async (req, res) => {
    const body = await readJson(req);
    hits.push({ headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, runUuid: "00000000-0000-0000-0000-000000000000" }));
    const reply = body.reply;
    if (answer && reply) {
      setTimeout(() => {
        void fetch(reply.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${reply.token}` },
          body: JSON.stringify({ requestId: reply.requestId, content: answer }),
        });
      }, delayMs);
    }
  });
  const base = await listen(srv);
  return { url: `${base}/automations/webhook/11111111`, hits, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
}

const KEYS = ["GROKBOTS_WEBHOOK_URL", "GROKBOTS_WEBHOOK_KEY", "GROKBOTS_BRIDGE_URL", "GROKBOTS_BRIDGE_KEY", "GROKBOTS_ROSTER_FILE", "GROKBOTS_DEFAULT_BOT"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function env(routine: string, bridge?: string, key = BRIDGE_KEY) {
  for (const k of KEYS) delete process.env[k];
  process.env.GROKBOTS_WEBHOOK_URL = routine;
  process.env.GROKBOTS_WEBHOOK_KEY = ROUTINE_KEY;
  process.env.GROKBOTS_DEFAULT_BOT = "example-agent";
  if (bridge) {
    process.env.GROKBOTS_BRIDGE_URL = bridge;
    process.env.GROKBOTS_BRIDGE_KEY = key;
  }
}
const out = (r: any) => JSON.parse(r.content[0].text);

test("end to end: send_prompt gets a reply route, the bot answers, wait_reply receives it", async () => {
  const bridge = await fakeBridge();
  const routine = await fakeRoutine("Done: 3 files changed.");
  try {
    env(routine.url, bridge.url);
    // dry-run: no network at all, no token in the preview
    const dry = out(await handleTool("send_prompt", { prompt: "summarise the diff" }, ro));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.payload.reply.token, "(issued by the bridge on confirm)");
    assert.equal(bridge.seen.length + routine.hits.length, 0);

    const sent = out(await handleTool("send_prompt", { prompt: "summarise the diff", confirm: true }, ro));
    assert.equal(sent.ok, true);
    assert.equal(sent.reply.expected, true);
    const requestId = sent.requestId as string;
    // the routine got a scoped reply route, never the bridge key
    const hit = routine.hits[0];
    assert.equal(hit.body.reply.requestId, requestId);
    assert.equal(hit.body.reply.url, `${bridge.url}/grokbuild/reply`);
    assert.match(hit.body.reply.token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(hit.body.reply.how, REPLY_HOW);
    assert.ok(!JSON.stringify(hit).includes(BRIDGE_KEY), "bridge key leaked to the routine");
    assert.ok(!JSON.stringify(sent).includes(hit.body.reply.token), "reply token echoed in tool output");
    assert.equal(bridge.seen[0].auth, `Bearer ${BRIDGE_KEY}`);
    assert.deepEqual(bridge.seen[0].body, { requestId, bot: "example-agent" });

    const w = out(await handleTool("wait_reply", { requestId, timeoutSec: 10 }, ro));
    assert.deepEqual([w.ok, w.state, w.replies[0].content], [true, "replied", "Done: 3 files changed."]);
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("send_prompt wait=true returns the reply in one call", async () => {
  const bridge = await fakeBridge();
  const routine = await fakeRoutine("pong");
  try {
    env(routine.url, bridge.url);
    const r = out(await handleTool("send_prompt", { prompt: "ping", confirm: true, wait: true, timeoutSec: 10 }, ro));
    assert.equal(r.ok, true);
    assert.deepEqual([r.waitResult.ok, r.waitResult.replies[0].content], [true, "pong"]);
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("bridge refuses the reply route: nothing is sent to the routine", async () => {
  const bridge = await fakeBridge({ expectStatus: 403 });
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url, bridge.url);
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    assert.deepEqual([r.ok, r.sent, r.errorCode, r.bridgeError], [false, false, "bridge_http_403", "read_only"]);
    assert.equal(routine.hits.length, 0);
    // a wrong bridge key is a 401, also nothing sent
    env(routine.url, bridge.url, "wrong-key-33333333");
    const bad = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    assert.equal(bad.errorCode, "bridge_http_401");
    assert.equal(routine.hits.length, 0);
    // expectReply:false sends one-way even with a bridge set
    const one = out(await handleTool("send_prompt", { prompt: "x", confirm: true, expectReply: false }, ro));
    assert.equal(one.ok, true);
    assert.equal(routine.hits[0].body.reply, undefined);
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("no bridge: one-way as before; wait=true and wait_reply refuse", async () => {
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url);
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    assert.equal(r.ok, true);
    assert.equal(r.reply, undefined);
    assert.equal(routine.hits[0].body.reply, undefined);
    const w = out(await handleTool("send_prompt", { prompt: "x", confirm: true, wait: true }, ro));
    assert.equal(w.sent, false);
    assert.equal(routine.hits.length, 1);
    const wr = out(await handleTool("wait_reply", { requestId: "abcdefgh-1234" }, ro));
    assert.match(wr.error, /bridge_not_configured/);
    assert.match(out(await handleTool("wait_reply", { requestId: "bad id" }, ro)).error, /requestId/);
  } finally {
    await routine.close();
  }
});

test("wait_reply: timeout with no reply, unknown id 404, unreachable bridge, bad config", async () => {
  const bridge = await fakeBridge();
  try {
    const b = loadBridge({ GROKBOTS_BRIDGE_URL: bridge.url, GROKBOTS_BRIDGE_KEY: BRIDGE_KEY });
    bridge.recs.set("pending-0001", { expires: Date.now() + 60_000, replies: [], waiters: [] });
    const t0 = Date.now();
    const idle = await waitReply(b, "pending-0001", 1);
    assert.ok(Date.now() - t0 >= 900);
    assert.deepEqual([idle.ok, idle.ok && idle.replies.length, idle.ok && idle.state], [true, 0, "awaiting_reply"]);
    const missing = await waitReply(b, "missing-0001", 1);
    assert.deepEqual([missing.ok, !missing.ok && missing.error], [false, "bridge_http_404"]);
  } finally {
    await bridge.close();
  }
  const down = await waitReply(loadBridge({ GROKBOTS_BRIDGE_URL: "http://127.0.0.1:9", GROKBOTS_BRIDGE_KEY: BRIDGE_KEY }), "any-00000001", 1);
  assert.deepEqual([down.ok, !down.ok && down.error], [false, "bridge_network_error"]);
  assert.deepEqual(loadBridge({ GROKBOTS_BRIDGE_URL: "http://bridge.example.com", GROKBOTS_BRIDGE_KEY: BRIDGE_KEY }).problems, ["GROKBOTS_BRIDGE_URL must use https (plain http only allowed for loopback)"]);
  assert.deepEqual(loadBridge({ GROKBOTS_BRIDGE_URL: "https://bridge.example.com" }).problems, ["GROKBOTS_BRIDGE_KEY not set"]);
  assert.equal(loadBridge({ GROKBOTS_BRIDGE_URL: "${GROKBOTS_BRIDGE_URL}", GROKBOTS_BRIDGE_KEY: "${GROKBOTS_BRIDGE_KEY}" }).configured, false);
});
