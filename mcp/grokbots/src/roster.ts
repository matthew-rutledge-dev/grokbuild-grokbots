/**
 * Roster of Grok Bots this caller can reach. Each bot is one Grok Bot
 * webhook-triggered routine: a POST URL plus a sender key.
 *
 * Sources (merged; names must be unique):
 * 1. Default bot from env: GROKBOTS_WEBHOOK_URL + GROKBOTS_WEBHOOK_KEY,
 *    named GROKBOTS_DEFAULT_BOT (default "default").
 * 2. Optional roster file at GROKBOTS_ROSTER_FILE (JSON):
 *    { "bots": [ { "name": "example-agent", "description": "...",
 *        "url": "https://example.com/webhook" | "urlEnv": "VAR",
 *        "keyEnv": "VAR" | "keyFile": "/path/to/key" } ] }
 *
 * Keys are never stored in the roster file itself and never returned by any tool.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnv } from "./env.js";
import { KEY_RE } from "./webhook.js";

export type BotEntry = {
  name: string;
  description?: string;
  source: "env" | "roster-file";
  url?: string;
  /** Where the key comes from, for display (env var name or "keyFile"). Never the key. */
  keyFrom?: string;
  /** Resolve the key lazily so it is only read for a confirmed send. */
  readKey: () => string | undefined;
  problems: string[];
};

export type Roster = { bots: BotEntry[]; errors: string[]; rosterFile?: string };

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** Environment variable names for urlEnv / keyEnv. Anything else is rejected and never echoed. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const ROSTER_NOT_JSON = "GROKBOTS_ROSTER_FILE is not valid JSON";
export const ROSTER_UNREADABLE = "GROKBOTS_ROSTER_FILE could not be read";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** https only; plain http only to loopback (local testing). No credentials in the URL. */
export function checkUrl(raw: string | undefined): string[] {
  if (!raw) return ["webhook URL not set"];
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return ["webhook URL is not a valid URL"];
  }
  const p: string[] = [];
  if (u.protocol === "http:") {
    if (!LOOPBACK.has(u.hostname)) p.push("webhook URL must use https (plain http only allowed for loopback)");
  } else if (u.protocol !== "https:") {
    p.push("webhook URL must use https");
  }
  if (u.username || u.password) p.push("webhook URL must not embed credentials");
  return p;
}

/** Host plus a redacted path, safe to show (the path id is not printed). */
export function redactUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    const shown = segs.length ? segs.slice(0, -1).concat("…").join("/") : "";
    return `${u.protocol}//${u.host}/${shown}`;
  } catch {
    return "(invalid URL)";
  }
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function readKeyFile(p: string): string | undefined {
  try {
    const v = fs.readFileSync(expandHome(p), "utf8").trim();
    return v === "" ? undefined : v;
  } catch {
    return undefined;
  }
}

export function loadRoster(env: NodeJS.ProcessEnv = process.env): Roster {
  const bots: BotEntry[] = [];
  const errors: string[] = [];

  const defUrl = readEnv("GROKBOTS_WEBHOOK_URL", env);
  const defKeySet = readEnv("GROKBOTS_WEBHOOK_KEY", env) !== undefined;
  if (defUrl || defKeySet) {
    const name = (readEnv("GROKBOTS_DEFAULT_BOT", env) ?? "default").toLowerCase();
    const problems = checkUrl(defUrl);
    if (!NAME_RE.test(name)) problems.push("GROKBOTS_DEFAULT_BOT is not a valid name (lowercase, digits, . _ -)");
    if (!defKeySet) problems.push("GROKBOTS_WEBHOOK_KEY not set");
    else if (!KEY_RE.test(readEnv("GROKBOTS_WEBHOOK_KEY", env) as string)) {
      problems.push("GROKBOTS_WEBHOOK_KEY is not valid (printable ASCII only, no spaces or line breaks)");
    }
    bots.push({
      name,
      description: readEnv("GROKBOTS_DEFAULT_BOT_DESCRIPTION", env),
      source: "env",
      url: defUrl,
      keyFrom: "GROKBOTS_WEBHOOK_KEY",
      readKey: () => readEnv("GROKBOTS_WEBHOOK_KEY", env),
      problems,
    });
  }

  const rosterFile = readEnv("GROKBOTS_ROSTER_FILE", env);
  if (rosterFile) {
    let parsed: unknown;
    let text: string | undefined;
    // Fixed messages only: fs / JSON.parse errors can quote paths or file contents (and so a key).
    try {
      text = fs.readFileSync(expandHome(rosterFile), "utf8");
    } catch {
      errors.push(ROSTER_UNREADABLE);
    }
    if (text !== undefined) {
      try {
        parsed = JSON.parse(text);
      } catch {
        errors.push(ROSTER_NOT_JSON);
      }
    }
    const list = (parsed as { bots?: unknown })?.bots;
    if (parsed !== undefined && !Array.isArray(list)) errors.push('roster file must be {"bots": [...]}');
    const entries = Array.isArray(list) ? list : [];
    for (let i = 0; i < entries.length; i++) {
      const b = (entries[i] ?? {}) as Record<string, unknown>;
      const name = typeof b.name === "string" ? b.name.trim().toLowerCase() : "";
      const problems: string[] = [];
      if (!NAME_RE.test(name)) {
        // The invalid value itself is not echoed: it could be anything, including a pasted key.
        errors.push(`roster entry #${i + 1} has an invalid name (lowercase, digits, . _ -); skipped`);
        continue;
      }
      if ("key" in b) problems.push('inline "key" is not allowed in the roster file; use keyEnv or keyFile');
      let url: string | undefined;
      if (typeof b.url === "string") {
        url = b.url.trim();
        problems.push(...checkUrl(url));
      } else if (typeof b.urlEnv === "string" && !ENV_NAME_RE.test(b.urlEnv)) {
        problems.push("urlEnv is not a valid environment variable name");
      } else {
        url = typeof b.urlEnv === "string" ? readEnv(b.urlEnv, env) : undefined;
        problems.push(...checkUrl(url));
      }
      let readKey: () => string | undefined = () => undefined;
      let keyFrom: string | undefined;
      if (typeof b.keyEnv === "string" && !ENV_NAME_RE.test(b.keyEnv)) {
        // Not echoed: a malformed keyEnv may be the key itself pasted in by mistake.
        keyFrom = "keyEnv (invalid name)";
        problems.push("keyEnv is not a valid environment variable name");
      } else if (typeof b.keyEnv === "string") {
        const v = b.keyEnv;
        keyFrom = v;
        readKey = () => readEnv(v, env);
      } else if (typeof b.keyFile === "string") {
        const f = b.keyFile;
        keyFrom = "keyFile";
        readKey = () => readKeyFile(f);
      } else {
        problems.push("no keyEnv or keyFile");
      }
      if (keyFrom && problems.every((p) => !p.startsWith("keyEnv "))) {
        const k = readKey();
        if (k === undefined) problems.push(`key not available from ${keyFrom}`);
        else if (!KEY_RE.test(k)) problems.push(`key from ${keyFrom} is not valid (printable ASCII only, no spaces or line breaks)`);
      }
      bots.push({
        name,
        description: typeof b.description === "string" ? b.description.slice(0, 200) : undefined,
        source: "roster-file",
        url,
        keyFrom,
        readKey,
        problems,
      });
    }
  }

  const seen = new Set<string>();
  const unique: BotEntry[] = [];
  for (const b of bots) {
    if (seen.has(b.name)) {
      errors.push(`duplicate bot name ${JSON.stringify(b.name)}; later entry ignored`);
      continue;
    }
    seen.add(b.name);
    unique.push(b);
  }
  return { bots: unique, errors, rosterFile };
}

/** Public view of a bot: never the key, never the full URL path. */
export function publicBot(b: BotEntry) {
  return {
    name: b.name,
    description: b.description,
    source: b.source,
    target: redactUrl(b.url),
    keyFrom: b.keyFrom,
    ready: b.problems.length === 0,
    problems: b.problems,
  };
}
