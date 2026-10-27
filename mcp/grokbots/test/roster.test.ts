import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkUrl, loadRoster, publicBot, redactUrl } from "../src/roster.js";
import { listTools } from "../src/tools.js";

const KEY = "placeholder-key-11111111";

test("checkUrl: https ok, http only on loopback, no embedded credentials", () => {
  assert.deepEqual(checkUrl("https://example.com/webhook"), []);
  assert.deepEqual(checkUrl("http://127.0.0.1:8080/hook"), []);
  assert.equal(checkUrl("http://example.com/webhook").length, 1);
  assert.equal(checkUrl("ftp://example.com/x").length, 1);
  assert.equal(checkUrl("https://u:p@example.com/x").length, 1);
  assert.equal(checkUrl(undefined)[0], "webhook URL not set");
});

test("redactUrl hides the last path segment (routine id)", () => {
  assert.equal(redactUrl("https://example.com/automations/webhook/11111111"), "https://example.com/automations/webhook/…");
});

test("env default bot; placeholders read as unset; key never in public view", () => {
  const r = loadRoster({ GROKBOTS_WEBHOOK_URL: "https://example.com/webhook/11111111", GROKBOTS_WEBHOOK_KEY: KEY });
  assert.equal(r.bots.length, 1);
  assert.equal(r.bots[0].name, "default");
  const pub = JSON.stringify(publicBot(r.bots[0]));
  assert.ok(!pub.includes(KEY));
  assert.ok(!pub.includes("11111111"));
  assert.equal(publicBot(r.bots[0]).ready, true);
  const none = loadRoster({ GROKBOTS_WEBHOOK_URL: "${GROKBOTS_WEBHOOK_URL}", GROKBOTS_WEBHOOK_KEY: "${GROKBOTS_WEBHOOK_KEY}" });
  assert.equal(none.bots.length, 0);
});

test("roster file: keyEnv / keyFile, inline key rejected, duplicates dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbots-"));
  const keyFile = path.join(dir, "b.key");
  fs.writeFileSync(keyFile, KEY + "\n");
  const file = path.join(dir, "roster.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      bots: [
        { name: "example-agent", url: "https://example.com/webhook/a", keyEnv: "EXAMPLE_AGENT_KEY" },
        { name: "example-helper", urlEnv: "EXAMPLE_HELPER_URL", keyFile },
        { name: "bad-inline", url: "https://example.com/webhook/c", key: "nope" },
        { name: "example-agent", url: "https://example.com/webhook/d", keyEnv: "X" },
        { name: "Bad Name!", url: "https://example.com/webhook/e" },
      ],
    }),
  );
  const r = loadRoster({ GROKBOTS_ROSTER_FILE: file, EXAMPLE_AGENT_KEY: KEY, EXAMPLE_HELPER_URL: "https://example.com/webhook/b" });
  assert.deepEqual(r.bots.map((b) => b.name), ["example-agent", "example-helper", "bad-inline"]);
  assert.equal(publicBot(r.bots[0]).ready, true);
  assert.equal(publicBot(r.bots[1]).ready, true);
  assert.equal(r.bots[1].readKey(), KEY);
  assert.equal(publicBot(r.bots[2]).ready, false);
  assert.ok(r.errors.some((e) => e.includes("duplicate")));
  assert.ok(r.errors.some((e) => e.includes("invalid name")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("read-only listing hides write tools; write tools require confirm in schema", () => {
  assert.deepEqual(listTools(true).map((t) => t.name), ["list_bots", "check_bot", "describe_boundary"]);
  for (const t of listTools(false).filter((t) => ["wake_bot", "send_prompt"].includes(t.name))) {
    assert.ok("confirm" in (t.inputSchema.properties as Record<string, unknown>));
  }
});
