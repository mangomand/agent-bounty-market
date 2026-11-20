import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BountyApi } from "./api-client";
import { registerTools } from "./tools";

export function createServer(api: BountyApi): McpServer {
  const server = new McpServer({ name: "agent-bounty-market", version: "0.1.0" });
  registerTools(server, api);
  return server;
}
