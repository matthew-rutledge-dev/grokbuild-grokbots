/**
 * Starts the built server over stdio the way hosts do (absolute path, neutral cwd,
 * unset plugin variables passed as literal ${...}). A local loopback mock stands in
 * for the Grok Bot webhook routine: no real webhook is called.
 */
import assert from "node:assert/strict";
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
const ALL = ["check_bot", "describe_boundary", "list_bots", "send_prompt", "wake_bot"];

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
  for (const k of ["GROKBOTS_WEBHOOK_URL", "GROKBOTS_WEBHOOK_KEY", "GROKBOTS_ROSTER_FILE", "GROKBOTS_READ_ONLY", "GROKBOTS_SENDER", "GROKBOTS_DEFAULT_BOT"]) {
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

test("stdio: 5 tools; dry-run sends nothing; confirm=true POSTs once with both key headers", async () => {
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
    assert.ok(!JSON.stringify(sent).includes(KEY));

    const wake = json(await client.callTool({ name: "wake_bot", arguments: { reason: "test", confirm: true } }));
    assert.equal(wake.ok, true);
    assert.equal(mock.hits[1].body.kind, "wake");

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
    assert.ok(!JSON.stringify(r).includes("wrong-key-22222222"));
  } finally {
    await client.close();
    await mock.close();
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
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["check_bot", "describe_boundary", "list_bots"]);
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
