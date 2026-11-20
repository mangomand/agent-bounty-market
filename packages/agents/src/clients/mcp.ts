import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_MCP_URL = "http://localhost:4000/mcp";

/** Result of one MCP tool call, with the text body parsed as JSON when possible. */
export interface ToolOutcome {
  ok: boolean;
  text: string;
  data: unknown;
}

/** Records every call so the demo (and tests) can show exactly what a client tried. */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  outcome: ToolOutcome;
}

export interface BountyMcp {
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  readonly calls: readonly ToolCallRecord[];
  close(): Promise<void>;
}

function toOutcome(result: CallToolResult): ToolOutcome {
  const text = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Errors come back as plain text.
  }
  return { ok: !result.isError, text, data };
}

/** Wraps a connected MCP client. Only the public bounty tools are ever called through it. */
export async function connectBountyMcp(transport: Transport, clientName = "abm-demo-client"): Promise<BountyMcp> {
  const client = new Client({ name: clientName, version: "0.1.0" });
  await client.connect(transport);
  const calls: ToolCallRecord[] = [];
  return {
    calls,
    async call(name, args) {
      let outcome: ToolOutcome;
      try {
        outcome = toOutcome((await client.callTool({ name, arguments: args })) as CallToolResult);
      } catch (e) {
        // Protocol-level rejection (e.g. unknown tool on some servers).
        const text = e instanceof Error ? e.message : String(e);
        outcome = { ok: false, text, data: text };
      }
      calls.push({ name, args, outcome });
      return outcome;
    },
    close: () => client.close(),
  };
}

/** Connects over Streamable HTTP, the transport the API serves at /mcp. */
export function connectHttp(url = DEFAULT_MCP_URL, clientName?: string): Promise<BountyMcp> {
  return connectBountyMcp(new StreamableHTTPClientTransport(new URL(url)), clientName);
}
