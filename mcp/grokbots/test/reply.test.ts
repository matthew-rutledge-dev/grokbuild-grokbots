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
import { DEFAULT_WAIT_SEC, bridgeUrl, checkInSec, loadBridge, progressTiming, replyUrlPreview, untilReplySec, waitReply, waitingFor } from "../src/bridge.js";

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
  const tombstones = new Map<string, string>();
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
      if (recs.has(body.requestId)) return send(409, { ok: false, error: "duplicate requestId" }); // like the real bridge
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
        state: tombstones.get(m[1]) ?? (r.replies.length ? "replied" : "awaiting_reply"),
        replies: r.replies,
        ...(r.created ? { createdAt: new Date(r.created).toISOString(), expiresAt: new Date(r.expires).toISOString() } : {}),
      });
    }
    send(404, { ok: false, error: "not_found" });
  });
  base = await listen(srv);
  return { url: base, seen, recs, tombstones, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
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
      // a wait was asked for, so waitResult is there, final, and nothing was waited on
      assert.deepEqual([r.waitResult.state, r.waitResult.done], ["not_sent", true]);
      assert.equal(bridge.seen.filter((x) => x.method === "GET").length, 0, "no wait after a refused send");
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

test("untilReply: keeps waiting past the check-in with or without host progress; progress only when asked", async () => {
  const bridge = await fakeBridge({ maxWait: 1 });
  const routine = await fakeRoutine("slow answer", 3500);
  try {
    env(routine.url, bridge.url);
    process.env.GROKBOTS_WAIT_MAX_SEC = "30";
    progressTiming.everySec = 0; // unthrottled here; the throttle has its own test
    const ticks: { n: number; m: string }[] = [];
    const ctx = { ...ro, progress: async (n: number, m: string) => void ticks.push({ n, m }) };
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true, wait: true, untilReply: true, timeoutSec: 1 }, ctx as never));
    assert.deepEqual([r.waitResult.state, r.waitResult.replies[0].content], ["replied", "slow answer"]);
    assert.ok(ticks.length >= 2, `progress updates sent (${ticks.length})`);
    assert.match(ticks[0].m, new RegExp(`^sent to example-agent, requestId ${r.requestId}: waiting`), "first update names the requestId");
    assert.match(ticks[1].m, /^still waiting, \d+ s for /);
    assert.ok(ticks.every((t, i) => i === 0 || t.n >= ticks[i - 1].n), "progress never goes down");
    // no progressToken: untilReply still blocks past the 1 s check-in until the reply lands
    const id = "pending-0002";
    const rec = { created: Date.now(), expires: Date.now() + 60_000, replies: [] as { content: string; at: string }[], waiters: [] as (() => void)[] };
    bridge.recs.set(id, rec);
    setTimeout(() => {
      rec.replies.push({ content: "late pong", at: new Date().toISOString() });
      for (const w of rec.waiters.splice(0)) w();
    }, 2500);
    const t0 = Date.now();
    const w = out(await handleTool("wait_reply", { requestId: id, untilReply: true, timeoutSec: 1 }, ro));
    assert.deepEqual([w.state, w.done, w.replies[0].content], ["replied", true, "late pong"]);
    assert.ok(Date.now() - t0 >= 2000, "blocked past the check-in");
    assert.equal(w.untilReply, undefined, "no 'limited' note any more");
  } finally {
    progressTiming.everySec = 25;
    await routine.close();
    await bridge.close();
  }
});

test("a requested wait always returns waitResult: timeout -> awaiting_reply, host abort -> aborted, both with the wait_reply hint", async () => {
  const bridge = await fakeBridge({ maxWait: 1 });
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url, bridge.url);
    process.env.GROKBOTS_WAIT_MAX_SEC = "30";
    // timeoutSec alone asks for a wait (no wait:true, no progressToken)
    const t = out(await handleTool("send_prompt", { prompt: "x", confirm: true, timeoutSec: 2 }, ro));
    assert.deepEqual([t.ok, t.waitResult?.state, t.waitResult?.done, t.waitResult?.next?.tool], [true, "awaiting_reply", false, "wait_reply"]);
    assert.ok(t.waitResult.checkedForSec >= 1);
    // untilReply without progress keeps polling until the host aborts the call
    const before = bridge.seen.filter((x) => x.method === "GET").length;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 2500);
    const u = out(await handleTool("send_prompt", { prompt: "x", confirm: true, untilReply: true, timeoutSec: 1 }, { ...ro, signal: ac.signal } as never));
    assert.deepEqual([u.ok, u.waitResult?.state, u.waitResult?.done, u.waitResult?.next?.tool], [true, "aborted", false, "wait_reply"]);
    assert.ok(bridge.seen.filter((x) => x.method === "GET").length - before >= 2, "polled past one 1 s check-in");
    assert.ok(bridge.recs.has(u.requestId), "abort keeps the route");
    // wait:false wins over untilReply / timeoutSec
    const n = out(await handleTool("send_prompt", { prompt: "x", confirm: true, wait: false, untilReply: true }, ro));
    assert.equal(n.waitResult, undefined);
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("progress is throttled to once per ~25 s even when the bridge answers at once (busy / long-poll off)", async () => {
  const bridge = await fakeBridge({ maxWait: 0 });
  const routine = await fakeRoutine("quick-ish", 5000);
  try {
    env(routine.url, bridge.url);
    process.env.GROKBOTS_WAIT_MAX_SEC = "30";
    const ticks: string[] = [];
    const ctx = { ...ro, progress: async (_n: number, m: string) => void ticks.push(m) };
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true, wait: true, untilReply: true, timeoutSec: 1 }, ctx as never));
    assert.equal(r.waitResult.state, "replied");
    const reads = bridge.seen.filter((x) => x.method === "GET").length;
    assert.ok(reads >= 2, `several immediate reads (${reads})`);
    assert.equal(ticks.length, 1, "one progress update in ~5 s, not one per read");
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("abort: the host cancels an untilReply wait; polling and progress stop at once", async () => {
  const bridge = await fakeBridge({ maxWait: 1 });
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url, bridge.url);
    process.env.GROKBOTS_WAIT_MAX_SEC = "60";
    const sent = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    const ac = new AbortController();
    let ticks = 0;
    const ctx = { ...ro, signal: ac.signal, progress: async () => void (ticks += 1) };
    setTimeout(() => ac.abort(), 2500);
    const t0 = Date.now();
    const w = out(await handleTool("wait_reply", { requestId: sent.requestId, untilReply: true, timeoutSec: 1 }, ctx as never));
    assert.ok(Date.now() - t0 < 3500, "returned promptly after the abort");
    assert.deepEqual([w.state, w.done], ["aborted", false]);
    const readsAtAbort = bridge.seen.filter((x) => x.method === "GET").length;
    const ticksAtAbort = ticks;
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(bridge.seen.filter((x) => x.method === "GET").length, readsAtAbort, "no reads after the abort");
    assert.equal(ticks, ticksAtAbort, "no progress after the abort");
    assert.ok(!bridge.seen.some((x) => x.method === "DELETE"), "an aborted wait keeps the route (wait_reply can resume)");
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("final states: 404 split into expired / cancelled / not_found; 401 is a final config error; bridge tombstones", async () => {
  const bridge = await fakeBridge();
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url, bridge.url);
    // never seen by this process: not_found with a config hint
    const nf = out(await handleTool("wait_reply", { requestId: "never-seen-0001", timeoutSec: 1 }, ro));
    assert.deepEqual([nf.done, nf.state], [true, "not_found"]);
    assert.match(nf.note, /GROKBOTS_BRIDGE_URL/);
    // seen, then gone before its expiry: cancelled
    const a = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    bridge.recs.delete(a.requestId);
    assert.equal(out(await handleTool("wait_reply", { requestId: a.requestId, timeoutSec: 1 }, ro)).state, "cancelled");
    // seen with an expiresAt that has passed, then swept: expired
    const id = "expiring-0001";
    bridge.recs.set(id, { created: Date.now(), expires: Date.now() + 1500, replies: [], waiters: [] });
    assert.equal(out(await handleTool("wait_reply", { requestId: id, timeoutSec: 1 }, ro)).state, "awaiting_reply");
    await new Promise((r) => setTimeout(r, 1000));
    bridge.recs.delete(id);
    const ex = out(await handleTool("wait_reply", { requestId: id, timeoutSec: 1 }, ro));
    assert.deepEqual([ex.done, ex.state], [true, "expired"]);
    // a tombstone read (bridge 0.2.3+) ends the wait with its state
    bridge.recs.set("tomb-00000001", { created: Date.now(), expires: Date.now() + 60_000, replies: [], waiters: [] });
    bridge.tombstones.set("tomb-00000001", "cancelled");
    const tb = out(await handleTool("wait_reply", { requestId: "tomb-00000001", timeoutSec: 5 }, ro));
    assert.deepEqual([tb.done, tb.state], [true, "cancelled"]);
    // wrong bridge key: final, with a hint
    env(routine.url, bridge.url, "wrong-key-33333333");
    const k = out(await handleTool("wait_reply", { requestId: a.requestId, timeoutSec: 1 }, ro));
    assert.deepEqual([k.done, k.state, k.error], [true, "config_error", "bridge_http_401"]);
    assert.match(k.note, /GROKBOTS_BRIDGE_KEY/);
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

test("send_prompt requestId: caller-supplied id is used, validated, and never sent twice (here or on the bridge)", async () => {
  const bridge = await fakeBridge({ maxWait: 1 });
  const routine = await fakeRoutine(undefined);
  try {
    env(routine.url, bridge.url);
    const bad = out(await handleTool("send_prompt", { prompt: "x", confirm: true, requestId: "no spaces!" }, ro));
    assert.deepEqual([bad.ok, bad.sent], [false, false]);
    assert.match(bad.error, /8-64/);
    const id = "caller-id-0001";
    const dry = out(await handleTool("send_prompt", { prompt: "x", requestId: id }, ro));
    assert.equal(dry.dryRun, true);
    const first = out(await handleTool("send_prompt", { prompt: "x", confirm: true, requestId: id }, ro));
    assert.deepEqual([first.ok, first.requestId, routine.hits[0].body.requestId], [true, id, id]);
    // resend after (say) a host timeout: refused, the bot is not run twice
    const again = out(await handleTool("send_prompt", { prompt: "x", confirm: true, requestId: id, untilReply: true }, ro));
    assert.deepEqual([again.ok, again.sent, again.errorCode, again.next?.tool], [false, false, "request_id_in_use", "wait_reply"]);
    // an id the bridge still has open (sent by another process): the bridge's 409 is refused the same way
    bridge.recs.set("other-proc-0001", { created: Date.now(), expires: Date.now() + 60_000, replies: [], waiters: [] });
    const other = out(await handleTool("send_prompt", { prompt: "x", confirm: true, requestId: "other-proc-0001" }, ro));
    assert.deepEqual([other.ok, other.sent, other.errorCode, other.httpStatus], [false, false, "request_id_in_use", 409]);
    assert.equal(routine.hits.length, 1, "one webhook POST in total");
  } finally {
    await routine.close();
    await bridge.close();
  }
});

test("send_unconfirmed: webhook connection dies after the POST -> waitResult done:false, next wait_reply; no read, no cancel", async () => {
  const bridge = await fakeBridge({ maxWait: 1 });
  const routine = await fakeRoutine(undefined, 0, 200, true, true);
  try {
    env(routine.url, bridge.url);
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true, untilReply: true }, ro));
    assert.equal(r.sent, "unknown");
    assert.deepEqual([r.waitResult.state, r.waitResult.done, r.waitResult.next?.tool, r.waitResult.next?.arguments?.requestId], ["send_unconfirmed", false, "wait_reply", r.requestId]);
    assert.equal(bridge.seen.filter((x) => x.method === "GET").length, 0, "no read");
    assert.equal(bridge.seen.filter((x) => x.method === "DELETE").length, 0, "no cancel");
    assert.ok(bridge.recs.has(r.requestId), "route kept");
  } finally {
    await routine.close();
    await bridge.close();
  }
});
