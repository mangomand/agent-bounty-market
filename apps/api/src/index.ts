import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { chainFromEnv } from "./chain";
import { config } from "./config";
import { openDb } from "./db";
import { httpRunner, unconfiguredRunner } from "./runner";

const db = openDb(config.dbPath);
const chain = chainFromEnv();
const { app } = createApp({
  db,
  runner: config.runnerUrl ? httpRunner(config.runnerUrl) : unconfiguredRunner,
  runnerSigners: config.runnerSigners,
  corsOrigins: config.corsOrigins,
  chain,
  autoRun: config.autoRun,
});

// Bind to loopback only: this is a local API.
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`@abm/api listening on http://127.0.0.1:${info.port} (db: ${config.dbPath})`);
  console.log(`MCP (Streamable HTTP): http://localhost:${info.port}/mcp`);
  if (chain) console.log(`chain ${chain.chainId}, BountyEscrow ${chain.contract}`);
  else console.log("No chain configured (BOUNTY_CONTRACT_ADDRESS + RELAYER_PRIVATE_KEY): running offchain only");
  if (!config.runnerUrl) console.log("RUNNER_URL not set: test and security runs will fail until a runner is configured");
});
