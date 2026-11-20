import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { config } from "./config";
import { openDb } from "./db";
import { httpRunner, unconfiguredRunner } from "./runner";

const db = openDb(config.dbPath);
const { app } = createApp({
  db,
  runner: config.runnerUrl ? httpRunner(config.runnerUrl) : unconfiguredRunner,
  runnerSigners: config.runnerSigners,
  corsOrigins: config.corsOrigins,
});

// Bind to loopback only: this is a local API.
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`@abm/api listening on http://127.0.0.1:${info.port} (db: ${config.dbPath})`);
  if (!config.runnerUrl) console.log("RUNNER_URL not set: test and security runs will fail until a runner is configured");
});
