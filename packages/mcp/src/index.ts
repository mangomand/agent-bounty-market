import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { httpApi } from "./api-client";
import { createServer } from "./server";

// stdout is the MCP channel: log to stderr only.
const apiUrl = process.env.ABM_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const server = createServer(httpApi(apiUrl));
await server.connect(new StdioServerTransport());
console.error(`@abm/mcp ready on stdio (API: ${apiUrl})`);
