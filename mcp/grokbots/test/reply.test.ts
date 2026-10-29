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
import { DEFAULT_WAIT_SEC, bridgeUrl, checkInSec, loadBridge, replyUrlPreview, untilReplySec, waitReply, waitingFor } from "../src/bridge.js";

const ROUTINE_KEY = "placeholder-key-11111111";
const BRIDGE_KEY = "placeholder-bridge-client-22222222";
const ro = { readOnly: { readOnly: false, source: "default" } } as never;

type Rec = { token?: string; created?: number; expires: number; replies: { content: string; at: string }[]; waiters: (() => void)[] };

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

async function fakeBridge(opts: { expectStatus?: number; prefix?: string; maxWait?: number } = {}) {
  const recs = new Map<string, Rec>();
  const seen: { method?: string; path: string; auth?: string; body?: any }[] = [];
  let base = "";
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (opts.prefix) {
      if (!url.pathname.startsWith(`${opts.prefix}/`)) return res.writeHead(404).end("{}");
      url.pathname = url.pathname.slice(opts.prefix.length);
    }
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const body = req.method === "POST" ? await readJson(req) : undefined;
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });
    const client = req.headers.authorization === `Bearer ${BRIDGE_KEY}`;
    if (url.pathname === "/grokbuild/expect") {
      if (!client) return send(401, { ok: false, error: "unauthorized" });
      if (opts.expectStatus) return send(opts.expectStatus, { ok: false, error: "read_only" });
      const token = crypto.randomBytes(32).toString("base64url");
      recs.set(body.requestId, { token, created: Date.now(), expires: Date.now() + 60_000, replies: [], waiters: [] });
      return send(201, { ok: true, requestId: body.requestId, replyUrl: `${base}${opts.prefix ?? ""}/grokbuild/reply`, replyToken: token, expiresAt: new Date(Date.now() + 60_000).toISOString() });
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
      if (req.method === "DELETE") {
        recs.delete(m[1]);
        for (const w of r.waiters.splice(0)) w();
        return send(200, { ok: true, requestId: m[1], cancelled: true });
      }
      const wait = Math.min(Number(url.searchParams.get("waitSec") ?? 0), opts.maxWait ?? 25);
      if (!r.replies.length && wait > 0) await new Promise<void>((done) => { r.waiters.push(done); setTimeout(done, wait * 1000); });
      return send(200, {
        ok: true,
        requestId: m[1],
        state: r.replies.length ? "replied" : "awaiting_reply",
        replies: r.replies,
        ...(r.created ? { createdAt: new Date(r.created).toISOString(), expiresAt: new Date(r.expires).toISOString() } : {}),
      });
    }
    send(404, { ok: false, error: "not_found" });
  });
  base = await listen(srv);
  return { url: base, seen, recs, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
}

/** The webhook routine + woken bot: 200 to the webhook, then (optionally) a reply on reply.url. */
async function fakeRoutine(answer: string | undefined, delayMs = 150, status = 200, success = true, drop = false) {
  const hits: any[] = [];
  const srv = http.createServer(async (req, res) => {
    const body = await readJson(req);
    hits.push({ headers: req.headers, body });
    // drop: the request arrived but the connection dies before any answer (sent: "unknown")
    if (drop) return void req.socket.destroy();
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ success, runUuid: "00000000-0000-0000-0000-000000000000" }));
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

const KEYS = ["GROKBOTS_WEBHOOK_URL", "GROKBOTS_WEBHOOK_KEY", "GROKBOTS_BRIDGE_URL", "GROKBOTS_BRIDGE_KEY", "GROKBOTS_ROSTER_FILE", "GROKBOTS_DEFAULT_BOT", "GROKBOTS_WAIT_SEC", "GROKBOTS_WAIT_MAX_SEC"];
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
    assert.deepEqual([w.ok, w.done, w.state, w.replies[0].content], [true, true, "replied", "Done: 3 files changed."]);
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
    assert.deepEqual([r.waitResult.ok, r.waitResult.state, r.waitResult.replies[0].content], [true, "replied", "pong"]);
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

test("bridge URL with a path prefix: calls and the dry-run reply URL keep it (URL joining)", async () => {
  assert.equal(bridgeUrl("https://bridge.example.com", "/grokbuild/expect"), "https://bridge.example.com/grokbuild/expect");
  assert.equal(bridgeUrl("https://bridge.example.com/base", "/grokbuild/expect"), "https://bridge.example.com/base/grokbuild/expect");
  assert.equal(bridgeUrl("https://bridge.example.com/base/", "grokbuild/requests/x?waitSec=5"), "https://bridge.example.com/base/grokbuild/requests/x?waitSec=5");
  const pv = (u: string) => replyUrlPreview(loadBridge({ GROKBOTS_BRIDGE_URL: u, GROKBOTS_BRIDGE_KEY: BRIDGE_KEY }));
  assert.equal(pv("https://bridge.example.com"), "https://bridge.example.com/grokbuild/reply");
  assert.equal(pv("https://bridge.example.com/"), "https://bridge.example.com/grokbuild/reply");
  assert.equal(pv("https://bridge.example.com/base"), "https://bridge.example.com/…/grokbuild/reply");
  assert.equal(pv("https://bridge.example.com/a/base"), "https://bridge.example.com/a/…/grokbuild/reply");

  const bridge = await fakeBridge({ prefix: "/base" });
  const routine = await fakeRoutine("prefixed ok");
  try {
    env(routine.url, `${bridge.url}/base`);
    const dry = out(await handleTool("send_prompt", { prompt: "x" }, ro));
    assert.equal(dry.payload.reply.url, `${bridge.url}/…/grokbuild/reply`);
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true, wait: true, timeoutSec: 10 }, ro));
    assert.deepEqual([r.ok, r.waitResult.replies[0].content], [true, "prefixed ok"]);
    assert.equal(routine.hits[0].body.reply.url, `${bridge.url}/base/grokbuild/reply`);
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("webhook refused after /expect: the reply route is cancelled (best effort)", async () => {
  for (const [status, success] of [[404, true], [200, false]] as const) {
    const bridge = await fakeBridge();
    const routine = await fakeRoutine(undefined, 0, status, success);
    try {
      env(routine.url, bridge.url);
      const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true, wait: true, timeoutSec: 5 }, ro));
      assert.equal(r.ok, false);
      assert.deepEqual([r.reply.expected, r.reply.cancelled], [false, true]);
      assert.equal(r.waitResult, undefined, "no wait after a refused send");
      const del = bridge.seen.find((x) => x.method === "DELETE");
      assert.equal(del?.path, `/grokbuild/requests/${r.requestId}`);
      assert.equal(del?.auth, `Bearer ${BRIDGE_KEY}`);
      assert.equal(bridge.recs.size, 0);
    } finally {
      await routine.close();
      await bridge.close();
    }
  }
  // an accepted send is never cancelled
  const bridge = await fakeBridge();
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url, bridge.url);
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    assert.equal(r.ok, true);
    assert.equal(r.reply.cancelled, undefined);
    assert.ok(!bridge.seen.some((x) => x.method === "DELETE"));
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("default wait fits common tool-call timeouts", () => {
  assert.equal(DEFAULT_WAIT_SEC, 45);
});

test("heartbeat: no reply yet is awaiting_reply (not an error) with elapsed time and a next step; later the reply lands", async () => {
  const bridge = await fakeBridge();
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url, bridge.url);
    const sent = out(await handleTool("send_prompt", { prompt: "long job", confirm: true, wait: true, timeoutSec: 1 }, ro));
    assert.equal(sent.ok, true);
    const hb = sent.waitResult;
    assert.deepEqual([hb.ok, hb.done, hb.state, hb.requestId], [true, false, "awaiting_reply", sent.requestId]);
    assert.ok(typeof hb.elapsedSec === "number" && hb.elapsedSec >= 1);
    assert.match(hb.waitingFor, /^still waiting, \d+ s$/);
    assert.deepEqual(hb.next, { tool: "wait_reply", arguments: { requestId: sent.requestId } });
    assert.match(hb.instruction, /Not a timeout.*call wait_reply again/);
    assert.ok(hb.expiresAt);
    // a later check-in: still waiting, not an MCP error
    const res = await handleTool("wait_reply", { requestId: sent.requestId, timeoutSec: 1 }, ro);
    assert.ok(!res?.isError, "awaiting_reply is not an error");
    assert.equal(out(res).state, "awaiting_reply");
    // the bot answers much later; the next check-in gets it
    const hook = routine.hits[0].body.reply;
    await fetch(hook.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${hook.token}` }, body: JSON.stringify({ requestId: hook.requestId, content: "finally" }) });
    const done = out(await handleTool("wait_reply", { requestId: sent.requestId, timeoutSec: 5 }, ro));
    assert.deepEqual([done.done, done.state, done.replies[0].content], [true, "replied", "finally"]);
    // cancelled / unknown on the bridge: done, stop waiting
    bridge.recs.clear();
    const gone = await handleTool("wait_reply", { requestId: sent.requestId, timeoutSec: 1 }, ro);
    assert.equal(gone?.isError, true);
    assert.deepEqual([out(gone).done, out(gone).state], [true, "cancelled"]);
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("untilReply: with host progress it keeps waiting past the check-in and reports progress; without, one check-in", async () => {
  const bridge = await fakeBridge({ maxWait: 1 });
  const routine = await fakeRoutine("slow answer", 3500);
  try {
    env(routine.url, bridge.url);
    process.env.GROKBOTS_WAIT_MAX_SEC = "30";
    const ticks: { n: number; m: string }[] = [];
    const ctx = { ...ro, progress: async (n: number, m: string) => void ticks.push({ n, m }) };
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true, wait: true, untilReply: true, timeoutSec: 1 }, ctx as never));
    assert.deepEqual([r.waitResult.state, r.waitResult.replies[0].content], ["replied", "slow answer"]);
    assert.ok(ticks.length >= 2, `progress updates sent (${ticks.length})`);
    assert.match(ticks[0].m, /^still waiting, \d+ s for /);
    assert.ok(ticks.every((t, i) => i === 0 || t.n >= ticks[i - 1].n), "progress never goes down");
    // no progressToken: untilReply is limited to one check-in and says so
    const id = "pending-0002";
    bridge.recs.set(id, { created: Date.now(), expires: Date.now() + 60_000, replies: [], waiters: [] });
    const lim = out(await handleTool("wait_reply", { requestId: id, untilReply: true, timeoutSec: 1 }, ro));
    assert.equal(lim.state, "awaiting_reply");
    assert.match(lim.untilReply, /^limited/);
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("webhook connection dies after the POST (sent: unknown): the reply route is NOT cancelled", async () => {
  const bridge = await fakeBridge();
  const routine = await fakeRoutine(undefined, 0, 200, true, true);
  try {
    env(routine.url, bridge.url);
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    assert.deepEqual([r.ok, r.sent, r.error], [false, "unknown", "webhook_network_error"]);
    assert.equal(r.reply.expected, true);
    assert.equal(r.reply.cancelled, undefined);
    assert.ok(!bridge.seen.some((x) => x.method === "DELETE"), "no DELETE sent");
    assert.equal(bridge.recs.size, 1, "route still open: the bot may still reply");
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("check-in and untilReply settings: env parsing and labels", () => {
  assert.equal(checkInSec({}), 45);
  assert.equal(checkInSec({ GROKBOTS_WAIT_SEC: "90" }), 90);
  assert.equal(checkInSec({ GROKBOTS_WAIT_SEC: "1" }), 5);
  assert.equal(checkInSec({ GROKBOTS_WAIT_SEC: "9999" }), 600);
  assert.equal(checkInSec({ GROKBOTS_WAIT_SEC: "soon" }), 45);
  assert.equal(checkInSec({ GROKBOTS_WAIT_SEC: "${GROKBOTS_WAIT_SEC}" }), 45);
  assert.equal(untilReplySec({}), 300);
  assert.equal(untilReplySec({ GROKBOTS_WAIT_MAX_SEC: "99999" }), 3600);
  assert.equal(waitingFor(12), "still waiting, 12 s");
  assert.equal(waitingFor(185), "still waiting, 3 min");
  assert.equal(waitingFor(3 * 3600 + 20 * 60), "still waiting, 3 h 20 min");
  assert.equal(waitingFor(7200), "still waiting, 2 h");
});
