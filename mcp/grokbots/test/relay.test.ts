/**
 * Relay mode, on loopback only. A fake bridge implements the GrokBuild adapter's relay API
 * like the real one: POST /grokbuild/prompt (client key, routed bots only, 409 for an id it
 * still has, 202 { requestId, state: "delivered" }), GET /grokbuild/status, GET
 * /grokbuild/requests/:id?waitSec=N (relayed requests stay "delivered" after the reply) and
 * DELETE (409 for a relayed request). The "bot" answers through the bridge's callback, which
 * the fake does by storing a reply after a delay. Also the direct-mode gateway 5xx case.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { handleTool, isRequestIdUsed } from "../src/tools.js";

const BRIDGE_KEY = "placeholder-bridge-client-22222222";
const ROUTINE_KEY = "placeholder-key-11111111";
const ro = { readOnly: { readOnly: false, source: "default" } } as never;
const out = (r: any) => JSON.parse(r.content[0].text);

type Rec = { replies: { content: string; at: string }[]; waiters: (() => void)[]; created: number };

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

async function relayBridge(opts: { bots?: string[]; answer?: string; delayMs?: number; promptStatus?: number; promptRaw?: string; readOnly?: boolean } = {}) {
  const bots = opts.bots ?? ["example-agent", "example_relay_bot"];
  const recs = new Map<string, Rec>();
  const seen: { method?: string; path: string; auth?: string; body?: any }[] = [];
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const body = req.method === "POST" ? await readJson(req) : undefined;
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${BRIDGE_KEY}`) return send(401, { ok: false, error: "unauthorized" });
    if (url.pathname === "/grokbuild/status") {
      return send(200, { ok: true, client: "example-client", readOnly: Boolean(opts.readOnly), replyChannel: "ready", directReplies: "ready", bots });
    }
    if (url.pathname === "/grokbuild/prompt") {
      if (opts.promptStatus) return res.writeHead(opts.promptStatus, { "content-type": "text/html" }).end(opts.promptRaw ?? "<html>Bad gateway</html>");
      if (opts.readOnly) return send(403, { ok: false, error: "read_only" });
      if (!bots.includes(body.bot)) return send(403, { ok: false, error: "no_route" });
      if (recs.has(body.requestId)) return send(409, { ok: false, error: "duplicate requestId" });
      const rec: Rec = { replies: [], waiters: [], created: Date.now() };
      recs.set(body.requestId, rec);
      if (opts.answer) {
        setTimeout(() => {
          rec.replies.push({ content: opts.answer as string, at: new Date().toISOString() });
          for (const w of rec.waiters.splice(0)) w();
        }, opts.delayMs ?? 150);
      }
      return send(202, { ok: true, requestId: body.requestId, state: "delivered" });
    }
    const m = /^\/grokbuild\/requests\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const r = recs.get(m[1]);
      if (!r) return send(404, { ok: false, error: "not_found" });
      if (req.method === "DELETE") return send(409, { ok: false, error: "only direct requests can be cancelled" });
      const wait = Math.min(Number(url.searchParams.get("waitSec") ?? 0), 25);
      if (!r.replies.length && wait > 0) await new Promise<void>((done) => { r.waiters.push(done); setTimeout(done, wait * 1000).unref(); });
      // Relayed requests never report "replied": the state stays "delivered" with replies.
      return send(200, { ok: true, requestId: m[1], bot: "x", state: "delivered", replies: r.replies, createdAt: new Date(r.created).toISOString() });
    }
    send(404, { ok: false, error: "not_found" });
  });
  const url = await listen(srv);
  return { url, seen, recs, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
}

const KEYS = ["GROKBOTS_BRIDGE_DEFAULT_BOT", "GROKBOTS_WEBHOOK_URL", "GROKBOTS_WEBHOOK_KEY", "GROKBOTS_BRIDGE_URL", "GROKBOTS_BRIDGE_KEY", "GROKBOTS_ROSTER_FILE", "GROKBOTS_DEFAULT_BOT", "GROKBOTS_WAIT_SEC", "GROKBOTS_WAIT_MAX_SEC"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
/** Relay only: the bridge is set, no webhook for any bot here. */
function relayEnv(bridge: string, extra: Record<string, string> = {}) {
  for (const k of KEYS) delete process.env[k];
  process.env.GROKBOTS_BRIDGE_URL = bridge;
  process.env.GROKBOTS_BRIDGE_KEY = BRIDGE_KEY;
  Object.assign(process.env, extra);
}
const prompts = (b: { seen: { path: string }[] }) => b.seen.filter((x) => x.path === "/grokbuild/prompt");
const deletes = (b: { seen: { method?: string }[] }) => b.seen.filter((x) => x.method === "DELETE");

test("relay success: list_bots/check_bot read /grokbuild/status; send_prompt untilReply posts /grokbuild/prompt and returns the reply", async () => {
  const bridge = await relayBridge({ answer: "relay ok", delayMs: 1200 });
  try {
    relayEnv(bridge.url);
    const list = out(await handleTool("list_bots", {}, ro));
    assert.deepEqual([list.ok, list.mode, list.count], [true, "relay", 2]);
    assert.deepEqual(list.bots.map((b: any) => [b.name, b.mode, b.ready]), [["example-agent", "relay", true], ["example_relay_bot", "relay", true]]);
    assert.ok(!JSON.stringify(list).includes(BRIDGE_KEY));
    const chk = out(await handleTool("check_bot", { bot: "example_relay_bot" }, ro));
    assert.deepEqual([chk.ok, chk.mode, chk.ready], [true, "relay", true]);
    const unrouted = out(await handleTool("check_bot", { bot: "example-unrouted" }, ro));
    assert.equal(unrouted.ok, false);
    assert.match(unrouted.problems.join(" "), /not routed/);

    const before = bridge.seen.length;
    const dry = out(await handleTool("send_prompt", { bot: "example_relay_bot", prompt: "summarise the diff" }, ro));
    assert.deepEqual([dry.dryRun, dry.mode, dry.endpoint], [true, "relay", "POST /grokbuild/prompt"]);
    assert.equal(bridge.seen.length, before, "dry-run: no network");

    const id = "relay-ok-id-0001";
    const r = out(await handleTool("send_prompt", { bot: "example_relay_bot", prompt: "summarise the diff", replyHint: "one line", requestId: id, confirm: true, untilReply: true }, ro));
    assert.deepEqual([r.ok, r.mode, r.sent, r.bridgeState, r.requestId], [true, "relay", true, "delivered", id]);
    // 'delivered' with replies is success: relayed requests never reach 'replied' on the bridge
    assert.deepEqual([r.waitResult.ok, r.waitResult.done, r.waitResult.state, r.waitResult.replies[0].content], [true, true, "replied", "relay ok"]);
    const p = prompts(bridge);
    assert.equal(p.length, 1);
    assert.equal(p[0].auth, `Bearer ${BRIDGE_KEY}`);
    // the exact body the bridge adapter accepts, bot name passed through as given
    assert.deepEqual(p[0].body, { bot: "example_relay_bot", prompt: "summarise the diff", requestId: id, replyHint: "one line" });
    assert.equal(bridge.seen.filter((x) => x.path === "/grokbuild/expect").length, 0, "relay never asks for a direct reply route");
    assert.equal(deletes(bridge).length, 0);
    // a later wait_reply reads the same reply
    const w = out(await handleTool("wait_reply", { requestId: id, timeoutSec: 2 }, ro));
    assert.deepEqual([w.ok, w.state, w.replies[0].content], [true, "replied", "relay ok"]);
  } finally {
    await bridge.close();
  }
});

test("relay timeout: no reply in the check-in -> awaiting_reply with the bridge state; abort keeps the request (no DELETE)", async () => {
  const bridge = await relayBridge();
  try {
    // the relay default may differ from the direct default: GROKBOTS_BRIDGE_DEFAULT_BOT wins in relay mode
    relayEnv(bridge.url, { GROKBOTS_DEFAULT_BOT: "example-direct-name", GROKBOTS_BRIDGE_DEFAULT_BOT: "example-agent" });
    const r = out(await handleTool("send_prompt", { prompt: "x", confirm: true, timeoutSec: 2 }, ro));
    assert.deepEqual([r.ok, r.sent, r.bot], [true, true, "example-agent"], "GROKBOTS_BRIDGE_DEFAULT_BOT names the relay bot");
    assert.deepEqual([r.waitResult.ok, r.waitResult.done, r.waitResult.state, r.waitResult.bridgeState, r.waitResult.next?.tool], [true, false, "awaiting_reply", "delivered", "wait_reply"]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const a = out(await handleTool("wait_reply", { requestId: r.requestId, untilReply: true }, { ...(ro as object), signal: ctrl.signal } as never));
    assert.deepEqual([a.state, a.done], ["aborted", false]);
    assert.equal(deletes(bridge).length, 0, "relay never DELETEs (the bridge answers 409)");
    assert.ok(bridge.recs.has(r.requestId), "request kept for a later wait_reply");
    // once the bridge drops the relayed record (replyTtlSec), a 404 is final: expired
    bridge.recs.delete(r.requestId);
    const gone = out(await handleTool("wait_reply", { requestId: r.requestId, timeoutSec: 1 }, ro));
    assert.deepEqual([gone.done, gone.state], [true, "expired"]);
  } finally {
    await bridge.close();
  }
});

test("relay requestId reuse: refused locally after a send, refused on the bridge's 409; a refused send frees the id", async () => {
  const bridge = await relayBridge();
  try {
    relayEnv(bridge.url);
    const id = "relay-reuse-0001";
    const first = out(await handleTool("send_prompt", { bot: "example-agent", prompt: "x", requestId: id, confirm: true }, ro));
    assert.deepEqual([first.ok, first.requestId], [true, id]);
    const again = out(await handleTool("send_prompt", { bot: "example-agent", prompt: "x", requestId: id, confirm: true, untilReply: true }, ro));
    assert.deepEqual([again.ok, again.sent, again.errorCode, again.next?.tool], [false, false, "request_id_in_use", "wait_reply"]);
    // an id the bridge already has (sent by another process): its 409 is request_id_in_use
    bridge.recs.set("relay-other-0001", { replies: [], waiters: [], created: Date.now() });
    const other = out(await handleTool("send_prompt", { bot: "example-agent", prompt: "x", requestId: "relay-other-0001", confirm: true }, ro));
    assert.deepEqual([other.ok, other.sent, other.errorCode, other.httpStatus], [false, false, "request_id_in_use", 409]);
    assert.equal(prompts(bridge).length, 2, "the local refusal made no call");
    assert.equal(deletes(bridge).length, 0);
  } finally {
    await bridge.close();
  }
  // refused by the bridge (read-only): not_sent, the id is free again, no DELETE
  const roBridge = await relayBridge({ readOnly: true });
  try {
    relayEnv(roBridge.url);
    const nr = out(await handleTool("send_prompt", { bot: "example-agent", prompt: "x", requestId: "relay-refused-0001", confirm: true, wait: true, timeoutSec: 2 }, ro));
    assert.deepEqual([nr.ok, nr.sent, nr.errorCode, nr.bridgeError, nr.waitResult.state], [false, false, "bridge_http_403", "read_only", "not_sent"]);
    assert.equal(isRequestIdUsed("relay-refused-0001"), false);
    assert.equal(deletes(roBridge).length, 0);
  } finally {
    await roBridge.close();
  }
});

test("relay fail-fast: a bot the bridge doesn't route (or a default that isn't routed) is refused with the routed list, nothing sent", async () => {
  const bridge = await relayBridge();
  try {
    relayEnv(bridge.url, { GROKBOTS_BRIDGE_DEFAULT_BOT: "example-not-routed" });
    const r = out(await handleTool("send_prompt", { bot: "example-unrouted", prompt: "x", requestId: "relay-unrouted-01", confirm: true, untilReply: true }, ro));
    assert.deepEqual([r.ok, r.sent, r.errorCode], [false, false, "bot_not_routed"]);
    assert.deepEqual(r.routedBots, ["example-agent", "example_relay_bot"]);
    assert.match(r.error, /example-agent, example_relay_bot/);
    assert.equal(isRequestIdUsed("relay-unrouted-01"), false);
    const d = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    assert.deepEqual([d.ok, d.sent, d.bot, d.errorCode], [false, false, "example-not-routed", "bot_not_routed"]);
    assert.equal(prompts(bridge).length, 0, "nothing sent");
    // no bot, no relay default: a clear error naming the variable
    relayEnv(bridge.url);
    const none = out(await handleTool("send_prompt", { prompt: "x", confirm: true }, ro));
    assert.match(none.error, /GROKBOTS_BRIDGE_DEFAULT_BOT/);
  } finally {
    await bridge.close();
  }
});

test("relay gateway 502 on /grokbuild/prompt: send_unconfirmed, id kept, no wait read, no DELETE", async () => {
  const bridge = await relayBridge({ promptStatus: 502 });
  try {
    relayEnv(bridge.url);
    const id = "relay-gw502-0001";
    const r = out(await handleTool("send_prompt", { bot: "example-agent", prompt: "x", requestId: id, confirm: true, untilReply: true }, ro));
    assert.deepEqual([r.ok, r.sent, r.httpStatus, r.waitResult.state, r.waitResult.done], [false, "unknown", 502, "send_unconfirmed", false]);
    assert.equal(isRequestIdUsed(id), true);
    assert.equal(bridge.seen.filter((x) => x.method === "GET" && x.path.startsWith("/grokbuild/requests/")).length, 0);
    assert.equal(deletes(bridge).length, 0);
  } finally {
    await bridge.close();
  }
});

test("mixed: a roster bot stays direct, another name relays; wake_bot refuses a relay bot; expectReply:false refused in relay", async () => {
  const bridge = await relayBridge({ answer: "from relay" });
  const hits: any[] = [];
  const routine = http.createServer(async (req, res) => {
    hits.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true }));
  });
  const routineUrl = await listen(routine);
  try {
    relayEnv(bridge.url, { GROKBOTS_WEBHOOK_URL: `${routineUrl}/automations/webhook/11111111`, GROKBOTS_WEBHOOK_KEY: ROUTINE_KEY, GROKBOTS_DEFAULT_BOT: "example-direct" });
    const d = out(await handleTool("send_prompt", { bot: "example-direct", prompt: "x", confirm: true, expectReply: false }, ro));
    assert.equal(d.ok, true);
    assert.equal(d.mode, undefined, "direct result unchanged");
    assert.equal(hits.length, 1);
    const rel = out(await handleTool("send_prompt", { bot: "example_relay_bot", prompt: "y", confirm: true, wait: true, timeoutSec: 5 }, ro));
    assert.deepEqual([rel.mode, rel.waitResult.replies[0].content], ["relay", "from relay"]);
    assert.equal(hits.length, 1, "relay never touches the webhook");
    const wake = out(await handleTool("wake_bot", { bot: "example_relay_bot", confirm: true }, ro));
    assert.equal(wake.ok, false);
    assert.match(wake.error, /direct webhook/);
    const er = out(await handleTool("send_prompt", { bot: "example_relay_bot", prompt: "y", confirm: true, expectReply: false }, ro));
    assert.deepEqual([er.ok, er.sent], [false, false]);
    const bad = out(await handleTool("send_prompt", { bot: "Example Bot", prompt: "y", confirm: true }, ro));
    assert.deepEqual([bad.ok, bad.sent], [false, false]);
  } finally {
    await new Promise<void>((r) => (routine.closeAllConnections(), routine.close(() => r())));
    await bridge.close();
  }
});

test("direct mode: a gateway 502/503/504 from the routine URL is send_unconfirmed (id kept, route not cancelled), not not_sent", async () => {
  for (const status of [502, 503, 504]) {
    // A direct-mode bridge: /expect issues a route; a DELETE would mean the route was cancelled.
    const expectSrv = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      await readJson(req);
      if (url.pathname === "/grokbuild/expect") return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, replyUrl: `${bridgeUrl}/grokbuild/reply`, replyToken: "placeholder-reply-token-0000", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      if (req.method === "DELETE") deleted += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    let deleted = 0;
    const bridgeUrl = await listen(expectSrv);
    const gw = http.createServer(async (req, res) => {
      await readJson(req);
      res.writeHead(status, { "content-type": "text/html" }).end("<html>gateway</html>");
    });
    const gwUrl = await listen(gw);
    const id = `direct-gw-${status}-01`;
    try {
      relayEnv(bridgeUrl, { GROKBOTS_WEBHOOK_URL: `${gwUrl}/automations/webhook/11111111`, GROKBOTS_WEBHOOK_KEY: ROUTINE_KEY, GROKBOTS_DEFAULT_BOT: "example-agent" });
      const r = out(await handleTool("send_prompt", { prompt: "x", requestId: id, confirm: true, untilReply: true }, ro));
      assert.deepEqual([r.ok, r.sent, r.error, r.waitResult.state, r.waitResult.done], [false, "unknown", `webhook_http_${status}`, "send_unconfirmed", false]);
      assert.equal(r.reply.cancelled, undefined, "route not cancelled");
      assert.equal(deleted, 0);
      assert.equal(isRequestIdUsed(id), true, "id kept");
    } finally {
      await new Promise<void>((r) => (gw.closeAllConnections(), gw.close(() => r())));
      await new Promise<void>((r) => (expectSrv.closeAllConnections(), expectSrv.close(() => r())));
    }
  }
});
