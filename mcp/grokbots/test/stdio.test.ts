/**
 * Starts the built server over stdio the way hosts do (absolute path, neutral cwd,
 * unset plugin variables passed as literal ${...}). A local loopback mock stands in
 * for the Grok Bot webhook routine: no real webhook is called.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(pkgDir, "dist", "index.js");
const KEY = "placeholder-key-11111111";
const ALL = ["check_bot", "describe_boundary", "list_bots", "send_prompt", "wait_reply", "wake_bot"];

type Hit = { headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

async function mockRoutine(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      hits.push({ headers: req.headers, body: JSON.parse(raw) });
      const ok = req.headers.authorization === `Bearer ${KEY}`;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { success: true, runUuid: "00000000-0000-0000-0000-000000000000" } : { success: false }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/automations/webhook/11111111`, hits, close: () => new Promise((r) => srv.close(() => r())) };
}

async function connect(extraEnv: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !k.startsWith("GROKBOTS_")) env[k] = v;
  for (const k of ["GROKBOTS_WEBHOOK_URL", "GROKBOTS_WEBHOOK_KEY", "GROKBOTS_ROSTER_FILE", "GROKBOTS_READ_ONLY", "GROKBOTS_SENDER", "GROKBOTS_DEFAULT_BOT", "GROKBOTS_BRIDGE_URL", "GROKBOTS_BRIDGE_KEY", "GROKBOTS_WAIT_SEC", "GROKBOTS_WAIT_MAX_SEC"]) {
    env[k] = "${" + k + "}";
  }
  Object.assign(env, extraEnv);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: os.tmpdir(), env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: "grokbots-test", version: "0.0.0" });
  await client.connect(transport);
  return Object.assign(client, { stderrText: () => stderr });
}

function json(res: unknown): Record<string, unknown> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

test("stdio: 6 tools; dry-run sends nothing; confirm=true POSTs once with both key headers", async () => {
  const mock = await mockRoutine();
  const client = await connect({ GROKBOTS_WEBHOOK_URL: mock.url, GROKBOTS_WEBHOOK_KEY: KEY, GROKBOTS_DEFAULT_BOT: "example-agent" });
  try {
    assert.equal(client.getServerVersion()?.name, "grokbots");
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ALL);

    const list = json(await client.callTool({ name: "list_bots", arguments: {} }));
    assert.equal((list.bots as Array<{ name: string; ready: boolean }>)[0].name, "example-agent");
    assert.ok(!JSON.stringify(list).includes(KEY));

    const dry = json(await client.callTool({ name: "send_prompt", arguments: { prompt: "hello from a test" } }));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.sent, false);
    assert.equal(mock.hits.length, 0);

    const sent = json(await client.callTool({ name: "send_prompt", arguments: { bot: "example-agent", prompt: "hello from a test", confirm: true } }));
    assert.equal(sent.ok, true);
    assert.equal(sent.httpStatus, 200);
    assert.equal(mock.hits.length, 1);
    assert.equal(mock.hits[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(mock.hits[0].headers["x-automation-key"], KEY);
    assert.equal(mock.hits[0].body.kind, "prompt");
    assert.equal(mock.hits[0].body.prompt, "hello from a test");
    assert.equal(mock.hits[0].body.bot, "example-agent");
    assert.ok(!JSON.stringify(sent).includes(KEY));

    const wake = json(await client.callTool({ name: "wake_bot", arguments: { reason: "test", confirm: true } }));
    assert.equal(wake.ok, true);
    assert.equal(mock.hits[1].body.kind, "wake");
    assert.equal(mock.hits[1].body.bot, "example-agent");

    const big = json(await client.callTool({ name: "send_prompt", arguments: { prompt: "x".repeat(8001), confirm: true } }));
    assert.equal(big.sent, false);
    assert.equal(mock.hits.length, 2);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("stdio: wrong key -> not accepted (401), reported, key not echoed", async () => {
  const mock = await mockRoutine();
  const client = await connect({ GROKBOTS_WEBHOOK_URL: mock.url, GROKBOTS_WEBHOOK_KEY: "wrong-key-22222222" });
  try {
    const r = json(await client.callTool({ name: "wake_bot", arguments: { confirm: true } }));
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 401);
    assert.equal(r.error, "webhook_http_401");
    assert.ok(!JSON.stringify(r).includes("wrong-key-22222222"));
  } finally {
    await client.close();
    await mock.close();
  }
});

test("stdio: payload names the roster entry that sent it (bot field, no secrets)", async () => {
  const mock = await mockRoutine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbots-"));
  const keyFile = path.join(dir, "k.key");
  fs.writeFileSync(keyFile, KEY);
  const rosterFile = path.join(dir, "roster.json");
  fs.writeFileSync(
    rosterFile,
    JSON.stringify({ bots: [{ name: "agent-one", url: mock.url, keyFile }, { name: "agent-two", url: mock.url, keyFile }] }),
  );
  const client = await connect({ GROKBOTS_ROSTER_FILE: rosterFile });
  try {
    const dry = json(await client.callTool({ name: "send_prompt", arguments: { bot: "agent-two", prompt: "hi" } }));
    assert.equal((dry.payload as Record<string, unknown>).bot, "agent-two");
    assert.equal(mock.hits.length, 0);

    const a = json(await client.callTool({ name: "send_prompt", arguments: { bot: "agent-two", prompt: "hi", confirm: true } }));
    const b = json(await client.callTool({ name: "wake_bot", arguments: { bot: "agent-one", confirm: true } }));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(mock.hits.length, 2);
    assert.equal(mock.hits[0].body.bot, "agent-two");
    assert.equal(mock.hits[1].body.bot, "agent-one");
    for (const h of mock.hits) {
      assert.ok(!JSON.stringify(h.body).includes(KEY));
      assert.ok(!JSON.stringify(h.body).includes(keyFile));
    }
  } finally {
    await client.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio: no HTTP response -> sent is \"unknown\", not retried", async () => {
  const mock = await mockRoutine();
  const url = mock.url;
  await mock.close(); // nothing listening now
  const client = await connect({ GROKBOTS_WEBHOOK_URL: url, GROKBOTS_WEBHOOK_KEY: KEY });
  try {
    const r = json(await client.callTool({ name: "wake_bot", arguments: { confirm: true } }));
    assert.equal(r.ok, false);
    assert.equal(r.sent, "unknown");
    assert.equal(r.error, "webhook_network_error");
    assert.ok(!JSON.stringify(r).includes(KEY));
  } finally {
    await client.close();
  }
});

test("stdio: key with a line break -> nothing sent, key not echoed", async () => {
  const mock = await mockRoutine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbots-"));
  const keyFile = path.join(dir, "b.key");
  fs.writeFileSync(keyFile, "split-secret-one\nsplit-secret-two\n");
  const rosterFile = path.join(dir, "roster.json");
  fs.writeFileSync(rosterFile, JSON.stringify({ bots: [{ name: "example-agent", url: mock.url, keyFile }] }));
  const client = await connect({ GROKBOTS_ROSTER_FILE: rosterFile });
  try {
    const r = json(await client.callTool({ name: "wake_bot", arguments: { confirm: true } }));
    assert.equal(r.ok, false);
    assert.equal(r.sent, false);
    assert.equal(mock.hits.length, 0);
    const out = JSON.stringify(r) + JSON.stringify(json(await client.callTool({ name: "list_bots", arguments: {} })));
    assert.ok(!out.includes("split-secret-one"));
    assert.ok(!out.includes("split-secret-two"));
  } finally {
    await client.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio: placeholders only -> no bots, writes refuse cleanly", async () => {
  const client = await connect({});
  try {
    const list = json(await client.callTool({ name: "list_bots", arguments: {} }));
    assert.equal(list.count, 0);
    const r = json(await client.callTool({ name: "send_prompt", arguments: { prompt: "hi", confirm: true } }));
    assert.equal(r.sent, false);
    assert.match(String(r.error), /No bots configured/);
  } finally {
    await client.close();
  }
});

test("stdio: GROKBOTS_READ_ONLY=enabled hides and refuses writes with one warning", async () => {
  const mock = await mockRoutine();
  const client = await connect({ GROKBOTS_WEBHOOK_URL: mock.url, GROKBOTS_WEBHOOK_KEY: KEY, GROKBOTS_READ_ONLY: "enabled" });
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["check_bot", "describe_boundary", "list_bots", "wait_reply"]);
    const r = json(await client.callTool({ name: "wake_bot", arguments: { confirm: true } }));
    assert.equal(r.readOnly, true);
    assert.equal(mock.hits.length, 0);
    const b = json(await client.callTool({ name: "describe_boundary", arguments: {} }));
    assert.equal(b.readOnly, true);
    assert.match(String(b.readOnlyStatus), /"enabled", unrecognised value treated as ON/);
    assert.equal((client.stderrText().match(/not a recognised value/g) ?? []).length, 1);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("stdio: wait_reply untilReply sends MCP progress notifications when the host asks (progressToken)", async () => {
  const BKEY = "placeholder-bridge-client-22222222";
  let reads = 0;
  const srv = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${BKEY}`;
    if (!ok) return void res.writeHead(401, { "content-type": "application/json" }).end('{"ok":false}');
    reads += 1;
    const created = new Date(Date.now() - 125_000).toISOString();
    const replied = reads >= 3;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, requestId: "pending-stdio1", state: replied ? "replied" : "awaiting_reply", createdAt: created, replies: replied ? [{ content: "pong", at: created }] : [] }),
      );
    }, 200);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const client = await connect({ GROKBOTS_BRIDGE_URL: `http://127.0.0.1:${port}`, GROKBOTS_BRIDGE_KEY: BKEY, GROKBOTS_WAIT_MAX_SEC: "30" });
  try {
    const progress: { progress: number; message?: string }[] = [];
    const res = await client.callTool({ name: "wait_reply", arguments: { requestId: "pending-stdio1", untilReply: true, timeoutSec: 1 } }, undefined, {
      onprogress: (p) => void progress.push(p),
      resetTimeoutOnProgress: true,
    });
    const body = json(res);
    assert.deepEqual([body.state, (body.replies as Array<{ content: string }>)[0].content], ["replied", "pong"]);
    // throttled: reads come about every 2 s here, progress at most once per ~25 s
    assert.equal(progress.length, 1, `progress notifications (${progress.length})`);
    assert.match(String(progress[0].message), /^still waiting, 2 min for pending-stdio1$/);
  } finally {
    await client.close();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("stdio: aborting an untilReply wait stops the bridge reads at once", async () => {
  const BKEY = "placeholder-bridge-client-22222222";
  let reads = 0;
  const srv = http.createServer((req, res) => {
    reads += 1;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, requestId: "pending-abort1", state: "awaiting_reply", createdAt: new Date().toISOString(), replies: [] }),
      );
    }, 200);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const client = await connect({ GROKBOTS_BRIDGE_URL: `http://127.0.0.1:${port}`, GROKBOTS_BRIDGE_KEY: BKEY, GROKBOTS_WAIT_MAX_SEC: "300" });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 3000);
    await assert.rejects(
      client.callTool({ name: "wait_reply", arguments: { requestId: "pending-abort1", untilReply: true, timeoutSec: 1 } }, undefined, {
        onprogress: () => undefined,
        signal: ac.signal,
      }),
    );
    // let the cancellation notification reach the server, then count
    await new Promise((r) => setTimeout(r, 500));
    const atAbort = reads;
    assert.ok(atAbort >= 1);
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(reads, atAbort, `no bridge reads after the abort (${atAbort} -> ${reads})`);
  } finally {
    await client.close();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("stdio: abort also ends the in-flight bridge long-poll (fetch is aborted, not left to finish)", async () => {
  const BKEY = "placeholder-bridge-client-22222222";
  let reads = 0;
  let closedAt = 0;
  const srv = http.createServer((req, res) => {
    reads += 1;
    // Hold the long-poll open far longer than the test: only an aborted fetch closes it early.
    const t = setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, requestId: "pending-abort2", state: "awaiting_reply", createdAt: new Date().toISOString(), replies: [] }),
      );
    }, 20_000);
    res.on("close", () => {
      clearTimeout(t);
      if (!res.writableEnded) closedAt = Date.now();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const client = await connect({ GROKBOTS_BRIDGE_URL: `http://127.0.0.1:${port}`, GROKBOTS_BRIDGE_KEY: BKEY, GROKBOTS_WAIT_MAX_SEC: "300" });
  try {
    const ac = new AbortController();
    const call = client.callTool({ name: "wait_reply", arguments: { requestId: "pending-abort2", untilReply: true, timeoutSec: 30 } }, undefined, {
      onprogress: () => undefined,
      signal: ac.signal,
    });
    // wait until the server's long-poll is open, then abort
    for (let i = 0; i < 50 && reads === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(reads, 1);
    const abortedAt = Date.now();
    ac.abort();
    await assert.rejects(call);
    for (let i = 0; i < 40 && !closedAt; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(closedAt > 0, "the bridge saw the long-poll connection closed");
    assert.ok(closedAt - abortedAt < 3000, `closed ${closedAt - abortedAt} ms after the abort`);
    assert.equal(reads, 1, "no new read after the abort");
  } finally {
    await client.close();
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("stdio: send_prompt untilReply blocks without a progressToken and returns the reply", async () => {
  const BKEY = "placeholder-bridge-client-22222222";
  const recs = new Map<string, { token: string; created: number; replies: { content: string; at: string }[]; waiters: (() => void)[] }>();
  let base = "";
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = raw ? JSON.parse(raw) : {};
      const send = (status: number, b: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (url.pathname === "/automations/webhook/11111111") {
        // the routine: accept, then the woken bot answers on reply.url about 3 s later
        send(200, { success: true, runUuid: "00000000-0000-0000-0000-000000000000" });
        const r = body.reply;
        setTimeout(() => {
          void fetch(r.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` }, body: JSON.stringify({ requestId: r.requestId, content: "pong" }) });
        }, 3000);
        return;
      }
      if (url.pathname === "/grokbuild/expect" && req.headers.authorization === `Bearer ${BKEY}`) {
        const token = "reply-token-placeholder-0000000000000000000";
        recs.set(body.requestId, { token, created: Date.now(), replies: [], waiters: [] });
        return send(201, { ok: true, requestId: body.requestId, replyUrl: `${base}/grokbuild/reply`, replyToken: token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (url.pathname === "/grokbuild/reply") {
        const r = recs.get(body.requestId);
        if (!r || req.headers.authorization !== `Bearer ${r.token}`) return send(401, { ok: false });
        r.replies.push({ content: body.content, at: new Date().toISOString() });
        for (const w of r.waiters.splice(0)) w();
        return send(200, { ok: true });
      }
      const m = /^\/grokbuild\/requests\/([^/]+)$/.exec(url.pathname);
      if (m && req.headers.authorization === `Bearer ${BKEY}`) {
        const r = recs.get(m[1]);
        if (!r) return send(404, { ok: false, error: "not_found" });
        const reply = () =>
          send(200, { ok: true, requestId: m[1], state: r.replies.length ? "replied" : "awaiting_reply", replies: r.replies, createdAt: new Date(r.created).toISOString() });
        const wait = Math.min(Number(url.searchParams.get("waitSec") ?? 0), 2);
        if (r.replies.length || wait === 0) return reply();
        let sent = false;
        const once = () => {
          if (sent) return;
          sent = true;
          reply();
        };
        setTimeout(once, wait * 1000);
        r.waiters.push(once);
        return;
      }
      send(404, { ok: false });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const client = await connect({
    GROKBOTS_WEBHOOK_URL: `${base}/automations/webhook/11111111`,
    GROKBOTS_WEBHOOK_KEY: KEY,
    GROKBOTS_BRIDGE_URL: base,
    GROKBOTS_BRIDGE_KEY: BKEY,
    GROKBOTS_WAIT_SEC: "5",
  });
  try {
    // no onprogress: the SDK sends no progressToken, like a headless host
    const t0 = Date.now();
    const res = json(await client.callTool({ name: "send_prompt", arguments: { prompt: "ping", confirm: true, untilReply: true, timeoutSec: 1 } }));
    const w = res.waitResult as Record<string, any> | undefined;
    assert.ok(w, `waitResult present (got keys: ${Object.keys(res).join(",")})`);
    assert.deepEqual([w.state, w.done, w.replies?.[0]?.content], ["replied", true, "pong"]);
    assert.ok(Date.now() - t0 >= 2500, "blocked until the reply");
    assert.equal(typeof w.checkedForSec, "number");
  } finally {
    await client.close();
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
