import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = resolve(fileURLToPath(import.meta.url), "../..");

export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  dbPath: process.env.API_DB_PATH ?? resolve(apiRoot, "data/abm.db"),
  runnerUrl: process.env.RUNNER_URL || undefined,
  runnerSigners: (process.env.RUNNER_SIGNER_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  corsOrigins: (process.env.WEB_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").map((s) => s.trim()),
};
