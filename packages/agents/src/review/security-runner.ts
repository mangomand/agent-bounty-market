import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunJob, RunnerClient, RunResult } from "@abm/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Llm } from "../llm";
import { loadReviewerFromEnv, signSecurityReview, type SignedSecurityReceipt, type SigningContext } from "./receipt";
import { readSourceTree, reviewSource, type ReviewOptions, type ReviewResult } from "./reviewer";

const run = promisify(execFile);

export interface ReviewAndSignInput {
  /** Directory holding the submission's source at `commitHash`. Read only. */
  dir: string;
  commitHash: string;
  apiBountyId: string;
  apiSubmissionId: string;
  onchainBountyId: string;
  onchainSubmissionId: string;
  spec?: string;
}

export interface ReviewAndSignOptions extends Omit<ReviewOptions, "spec"> {
  signing: SigningContext;
  /** Defaults to REVIEWER_SIGNER_PRIVATE_KEY. */
  account?: PrivateKeyAccount;
  ttlSec?: number;
}

/** Reviews a source tree and signs a SecurityReviewReceipt with the result (pass or fail). */
export async function reviewAndSign(
  input: ReviewAndSignInput,
  opts: ReviewAndSignOptions,
): Promise<{ review: ReviewResult; receipt: SignedSecurityReceipt }> {
  const account = opts.account ?? loadReviewerFromEnv();
  const review = await reviewSource(await readSourceTree(input.dir), { ...opts, spec: input.spec });
  const receipt = await signSecurityReview(
    {
      apiBountyId: input.apiBountyId,
      apiSubmissionId: input.apiSubmissionId,
      onchainBountyId: input.onchainBountyId,
      onchainSubmissionId: input.onchainSubmissionId,
      commitHash: input.commitHash,
      pass: review.pass,
      ttlSec: opts.ttlSec,
    },
    opts.signing,
    account,
  );
  return { review, receipt };
}

/** Writes a RunJob's source into a fresh temp dir. Caller removes it. */
export async function materializeSource(source: RunJob["source"]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "abm-review-"));
  const src = join(dir, "src");
  try {
    if (source.kind === "tarball") {
      const archive = join(dir, "source.tar.gz");
      await writeFile(archive, Buffer.from(source.base64, "base64"));
      await mkdir(src);
      // tar refuses absolute and `..` member paths by default; never preserve owners.
      await run("tar", ["-xzf", archive, "-C", src, "--no-same-owner"], { timeout: 60_000 });
    } else {
      await run("git", ["init", "-q", src]);
      await run("git", ["-C", src, "fetch", "-q", "--depth", "1", source.repoUrl, source.commitHash], {
        timeout: 120_000,
        env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" },
      });
      await run("git", ["-C", src, "checkout", "-q", "FETCH_HEAD"]);
    }
    return dir;
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

export interface SecurityReviewRunnerOptions extends ReviewAndSignOptions {
  /** Maps a job to its onchain uint256 ids (the API does not store the submission's onchain id yet). */
  onchainIds: (job: RunJob) => { bountyId: string; submissionId: string };
  llm?: Llm;
}

/**
 * A `RunnerClient` that handles `kind: "security"` jobs: fetch the source, review it,
 * and return one signed SecurityReviewReceipt. Other job kinds throw.
 */
export function securityReviewRunner(opts: SecurityReviewRunnerOptions): RunnerClient {
  return {
    async run(job: RunJob): Promise<RunResult> {
      if (job.kind !== "security") throw new Error(`securityReviewRunner cannot run ${job.kind} jobs`);
      const ids = opts.onchainIds(job);
      const dir = await materializeSource(job.source);
      try {
        const { receipt } = await reviewAndSign(
          {
            dir: join(dir, "src"),
            commitHash: job.submission.commitHash,
            apiBountyId: job.bounty.id,
            apiSubmissionId: job.submission.id,
            onchainBountyId: ids.bountyId,
            onchainSubmissionId: ids.submissionId,
            spec: job.bounty.spec,
          },
          opts,
        );
        return { receipts: [receipt.apiReceipt] };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
