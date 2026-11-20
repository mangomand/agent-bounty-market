import { createServer, type IncomingMessage, type Server } from "node:http";
import { addressSchema, commitHashSchema, MAX_TARBALL_BYTES, type Hex, type RunJob } from "@abm/shared";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { selectBackend } from "./backend.js";
import { runJob, type JobRunnerOptions } from "./job.js";
import { loadSecurityReviewer } from "./security.js";
import { loadSignerFromEnv } from "./signer.js";

/**
 * The runner as its own process. It is the only process holding the receipt signing keys.
 * The API calls POST /run with a RunJob and gets back signed receipts plus a log tail.
 */

const uint = z.string().regex(/^\d{1,78}$/);
/** Only the fields the runner reads. Everything else in the job is ignored. */
const jobSchema = z.object({
  runId: z.string().max(64),
  kind: z.enum(["test", "security"]),
  bounty: z.object({ onchainId: uint, testCommand: z.string().min(1).max(500) }).passthrough(),
  submission: z.object({ onchainId: uint, commitHash: commitHashSchema }).passthrough(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("git"), repoUrl: z.string().url().startsWith("https://"), commitHash: commitHashSchema }),
    z.object({ kind: z.literal("tarball"), base64: z.string().max(Math.ceil(MAX_TARBALL_BYTES / 3) * 4) }),
  ]),
});

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createRunnerServer(opts: JobRunnerOptions): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, backend: opts.backend });
    if (req.method !== "POST" || req.url !== "/run") return send(404, { error: "not found" });
    void (async () => {
      let job: RunJob;
      try {
        const parsed = jobSchema.safeParse(await readJson(req, MAX_TARBALL_BYTES * 2));
        if (!parsed.success) return send(400, { error: z.prettifyError(parsed.error) });
        job = parsed.data as unknown as RunJob;
      } catch {
        return send(400, { error: "invalid JSON" });
      }
      try {
        const result = await runJob(job, opts);
        console.error(`[runner] ${job.kind} run ${job.runId}: ${result.receipts.map((r) => `${r.receiptType}=${r.result}`).join(" ")}`);
        send(200, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[runner] ${job.kind} run ${job.runId} failed: ${message}`);
        send(500, { error: message });
      }
    })();
  });
}

/** Reads runner config from env. Keys come from env only and never leave this process. */
export async function runnerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<JobRunnerOptions> {
  const contract = addressSchema.parse(env.BOUNTY_CONTRACT_ADDRESS) as Hex;
  const reviewerKey = env.REVIEWER_SIGNER_PRIVATE_KEY;
  const { backend, executor } = await selectBackend(env);
  return {
    backend,
    executor,
    signing: { chainId: Number(env.CHAIN_ID ?? 31337), verifyingContract: contract },
    runnerSigner: loadSignerFromEnv(env),
    reviewerSigner: reviewerKey ? privateKeyToAccount(reviewerKey as Hex) : undefined,
    reviewer: await loadSecurityReviewer(env),
    // Back-date receipts slightly so `timestamp <= block.timestamp` holds on a fresh block.
    runOptions: { now: () => Date.now() - 5_000 },
  };
}
