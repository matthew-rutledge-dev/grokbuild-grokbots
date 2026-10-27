/**
 * Environment reader for the grokbots MCP server.
 *
 * Some hosts pass unset plugin variables through literally (for example
 * GROKBOTS_WEBHOOK_URL="${GROKBOTS_WEBHOOK_URL}"). Treat those, and empty or
 * whitespace-only values, as unset so they never reach a webhook.
 */
const PLACEHOLDER = /^\$\{[^}]*\}$/;

export function isUnsetValue(value: string | undefined | null): boolean {
  if (typeof value !== "string") return true;
  const v = value.trim();
  return v === "" || PLACEHOLDER.test(v);
}

/** Trimmed env value, or undefined when unset, empty, or an unexpanded ${...} placeholder. */
export function readEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[name];
  return isUnsetValue(raw) ? undefined : (raw as string).trim();
}
