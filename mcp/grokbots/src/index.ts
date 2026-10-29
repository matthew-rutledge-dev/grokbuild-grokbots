#!/usr/bin/env node
/**
 * grokbots MCP — lets Grok Build (or Cursor) wake a Grok Bot or send it a prompt
 * through the bot's documented webhook-triggered routine.
 * Read tools: list_bots, check_bot, describe_boundary (no network).
 * Write tools: wake_bot, send_prompt (confirm=true required; hidden in read-only mode,
 * GROKBOTS_READ_ONLY on; unrecognised non-empty values also mean on).
 * No undocumented gateway. Keys from env / key files only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readOnlyResolutionFromEnv, type ReadOnlyResolution } from "./readonly.js";
import { jsonResult } from "./result.js";
import { READ_ONLY_ENV, handleTool, isWriteTool, listTools } from "./tools.js";
import { SERVER_NAME, VERSION } from "./version.js";

/** Read-only is resolved once at start; every handler uses this resolution. */
export function createServer(readOnlyState: ReadOnlyResolution): Server {
  const readOnly = readOnlyState.readOnly;
  const server = new Server({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(readOnly) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (readOnly && isWriteTool(name)) {
      return jsonResult(
        { ok: false, readOnly: true, sent: false, error: `Refused: ${name} is a write tool and ${READ_ONLY_ENV} is on. Nothing sent.` },
        true,
      );
    }
    try {
      // Progress updates only when the host asked for them; a failed notification never fails the call.
      const token = request.params._meta?.progressToken;
      const progress =
        token === undefined
          ? undefined
          : async (n: number, message: string) => {
              try {
                await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message } });
              } catch {
                /* host went away; the wait ends on its own */
              }
            };
      const result = await handleTool(name, args, { readOnly: readOnlyState, progress });
      return result ?? jsonResult({ error: `Unknown tool: ${name}` }, true);
    } catch {
      // Fixed text only: a raw error message could quote config or a key.
      return jsonResult({ ok: false, sent: false, error: "internal_error: the tool failed. Nothing more is reported here." }, true);
    }
  });
  return server;
}

async function main() {
  const readOnlyState = readOnlyResolutionFromEnv();
  if (readOnlyState.warning) console.error(readOnlyState.warning);
  await createServer(readOnlyState).connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
