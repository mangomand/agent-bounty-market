import { z } from "zod";
import { signedReceiptSchema, type RunJob, type RunResult, type RunnerClient } from "@abm/shared";

const runResultSchema = z.object({ receipts: z.array(signedReceiptSchema) });

/**
 * Calls a runner over HTTP: POST {baseUrl}/run with a RunJob, expects a RunResult.
 * The runner may instead post receipts to POST /submissions/:id/receipts itself and return { receipts: [] }.
 */
export function httpRunner(baseUrl: string, timeoutMs = 10 * 60_000): RunnerClient {
  return {
    async run(job: RunJob): Promise<RunResult> {
      const res = await fetch(new URL("/run", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`runner returned ${res.status}`);
      return runResultSchema.parse(await res.json());
    },
  };
}

/** Used when RUNNER_URL is unset: every run fails with a clear error instead of faking receipts. */
export const unconfiguredRunner: RunnerClient = {
  async run() {
    throw new Error("runner not configured: set RUNNER_URL");
  },
};
