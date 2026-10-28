/**
 * Read-only mode switch for the grokbots MCP server.
 *
 * Fails closed:
 * - unset, empty, or an unexpanded ${...} placeholder -> off
 * - explicit off values (0, false, no, off; case-insensitive) -> off
 * - recognised on values (1, true, yes, on) -> on
 * - ANY other non-empty value -> on, with a warning for the operator
 */
export const READ_ONLY_ENV = "GROKBOTS_READ_ONLY";

const ON_VALUES = ["1", "true", "yes", "on"];
const OFF_VALUES = ["0", "false", "no", "off"];

/**
 * How the flag was classified at startup.
 * - unset: not set, empty, or an unexpanded ${...} placeholder
 * - off: explicit off value (0/false/no/off)
 * - on: recognised on value (1/true/yes/on)
 * - unrecognised: any other non-empty value, treated as ON
 */
export type ReadOnlySource = "unset" | "off" | "on" | "unrecognised";

export type ReadOnlyResolution = {
  readOnly: boolean;
  source: ReadOnlySource;
  /** Trimmed flag value (max 32 chars) for on/off/unrecognised; never another env var. */
  raw?: string;
  /** For source "unset": which kind of unset. */
  unsetKind?: "not set" | "empty" | "unexpanded placeholder";
  /** Set when the value was not a recognised on/off value (treated as on). */
  warning?: string;
};

const RAW_MAX = 32;
const PLACEHOLDER = /^\$\{[^}]*\}$/;

/**
 * Resolve the raw flag value (exactly as found in env, or undefined).
 * Empty and ${...} placeholders count as unset.
 */
export function resolveReadOnly(value: string | undefined | null): ReadOnlyResolution {
  if (typeof value !== "string") {
    return { readOnly: false, source: "unset", unsetKind: "not set" };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { readOnly: false, source: "unset", unsetKind: "empty" };
  if (PLACEHOLDER.test(trimmed)) {
    return { readOnly: false, source: "unset", unsetKind: "unexpanded placeholder" };
  }
  const raw = trimmed.slice(0, RAW_MAX);
  const v = trimmed.toLowerCase();
  if (OFF_VALUES.includes(v)) return { readOnly: false, source: "off", raw };
  if (ON_VALUES.includes(v)) return { readOnly: true, source: "on", raw };
  return {
    readOnly: true,
    source: "unrecognised",
    raw,
    warning: `grokbots: ${READ_ONLY_ENV}=${JSON.stringify(raw)} is not a recognised value; treating it as ON (read-only, wake_bot and send_prompt hidden). Use 1/true/yes/on or 0/false/no/off.`,
  };
}

/** One-line human status for the resolved flag. Echoes only this flag's value. */
export function describeReadOnly(r: ReadOnlyResolution): string {
  const shown = r.raw !== undefined ? JSON.stringify(r.raw) : "";
  switch (r.source) {
    case "on":
      return `read-only ON (${READ_ONLY_ENV}=${shown})`;
    case "unrecognised":
      return `read-only ON (${READ_ONLY_ENV}=${shown}, unrecognised value treated as ON)`;
    case "off":
      return `read-only OFF (${READ_ONLY_ENV}=${shown}, explicit off value)`;
    default:
      return `read-only OFF (${READ_ONLY_ENV} unset: ${r.unsetKind ?? "not set"})`;
  }
}

/** Boolean form of resolveReadOnly. */
export function parseReadOnly(value: string | undefined | null): boolean {
  return resolveReadOnly(value).readOnly;
}

/** Resolve GROKBOTS_READ_ONLY from env (placeholders and empty = unset). */
export function readOnlyResolutionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReadOnlyResolution {
  return resolveReadOnly(env[READ_ONLY_ENV]);
}

export function readOnlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return readOnlyResolutionFromEnv(env).readOnly;
}
