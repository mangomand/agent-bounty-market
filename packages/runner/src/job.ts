import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunJob, RunResult as ApiRunResult, SignedReceipt as ApiSignedReceipt } from "@abm/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import { truncateLog } from "./digest.js";
import { minimalEnv, runCommand, type CommandRunner } from "./process.js";
import { runSubmission, type RunOptions, type StepResult } from "./runner.js";
import type { SandboxExecutor } from "./sandbox.js";
import { defaultSecurityReviewer, type SecurityReviewer } from "./security.js";
import { signReceipt, type SignedReceipt, type SigningContext } from "./signer.js";

/** Build step every bounty gets; the test command comes from the locked bounty spec. */
export const DEFAULT_BUILD_COMMAND = "npm run build --if-present";
export const RUNNER_VERSION = "abm-runner-0.1.0";
const MAX_LOG_CHARS = 8_000;

export interface JobRunnerOptions {
  executor: SandboxExecutor;
  /** "docker" or "process"; recorded in the receipt's runnerVersion. */
  backend: string;
  signing: SigningContext;
  /** Signs build and test receipts (RUNNER_ROLE). */
  runnerSigner: PrivateKeyAccount;
  /** Signs security review receipts (REVIEWER_ROLE). Defaults to runnerSigner. */
  reviewerSigner?: PrivateKeyAccount;
  reviewer?: SecurityReviewer;
  run?: CommandRunner;
  /** Passed through to runSubmission (timeouts, limits, sandbox dir, clock). */
  runOptions?: Partial<RunOptions>;
}

/** Turns the runner's receipt into the flat shape the API stores. */
export function toApiReceipt(s: SignedReceipt): ApiSignedReceipt {
  return { ...s.receipt, commitHash: s.receipt.commitHash.toLowerCase().replace(/^0x/, ""), signature: s.signature, signer: s.signer };
}

function onchainIds(job: RunJob): { bountyId: string; submissionId: string } {
  const bountyId = job.bounty.onchainId;
  const submissionId = job.submission.onchainId;
  if (!bountyId || !submissionId) throw new Error("bounty and submission must be registered onchain before a run");
  return { bountyId, submissionId };
}

/** Extracts or clones the submission into a fresh host dir. Caller removes `root`. */
export async function materializeSource(job: RunJob, run: CommandRunner = runCommand): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "abm-source-"));
  const dir = join(root, "src");
  const env = { ...minimalEnv(), GIT_TERMINAL_PROMPT: "0" };
  const check = (r: { exitCode: number | null; stderr: string }, what: string) => {
    if (r.exitCode !== 0) throw new Error(`${what} failed: ${r.stderr.trim().slice(0, 500)}`);
  };
  try {
    if (job.source.kind === "tarball") {
      const file = join(root, "source.tar.gz");
      await writeFile(file, Buffer.from(job.source.base64, "base64"));
      await mkdir(dir);
      // tar refuses absolute paths and `..` members by default.
      check(await run("tar", ["-xzf", file, "-C", dir, "--no-same-owner"], { timeoutMs: 60_000, env }), "extracting tarball");
      await rm(file, { force: true });
      // Accept tarballs with a single top-level folder.
      const entries = await readdir(dir);
      if (entries.length === 1 && (await stat(join(dir, entries[0]!))).isDirectory()) return { root, dir: join(dir, entries[0]!) };
      return { root, dir };
    }
    const { repoUrl, commitHash } = job.source;
    check(await run("git", ["clone", "--quiet", "--no-checkout", "--", repoUrl, dir], { timeoutMs: 120_000, env }), "git clone");
    check(await run("git", ["-C", dir, "checkout", "--quiet", "--detach", commitHash], { timeoutMs: 60_000, env }), "git checkout");
    const head = await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 10_000, env });
    if (head.stdout.trim() !== commitHash) throw new Error(`checked out ${head.stdout.trim()}, expected ${commitHash}`);
    await rm(join(dir, ".git"), { recursive: true, force: true });
    return { root, dir };
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  }
}

function stepLog(name: string, step: StepResult): string {
  const out = [step.stdout, step.stderr].filter((s) => s.trim()).join("\n");
  return `$ ${name}: ${step.status}${step.exitCode !== null ? ` (exit ${step.exitCode})` : ""}\n${out}`.trim();
}

/** Runs one API job: `test` → Build + Test receipts, `security` → SecurityReview receipt. */
export async function runJob(job: RunJob, opts: JobRunnerOptions): Promise<ApiRunResult> {
  const ids = onchainIds(job);
  const runnerVersion = `${RUNNER_VERSION}+${opts.backend}`;
  const { root, dir } = await materializeSource(job, opts.run);
  try {
    if (job.kind === "test") {
      const res = await runSubmission(
        {
          ...ids,
          snapshotPath: dir,
          commitHash: job.submission.commitHash,
          buildCommand: DEFAULT_BUILD_COMMAND,
          testCommand: job.bounty.testCommand,
          runnerVersion,
        },
        { ...opts.runOptions, signing: opts.signing, signer: opts.runnerSigner, executor: opts.executor },
      );
      // Failing output first so agents see the reason without scrolling.
      const logs = res.build.status !== "passed" ? stepLog("build", res.build) : stepLog(job.bounty.testCommand, res.test);
      return { receipts: res.receipts.map(toApiReceipt), logs: truncateLog(logs, MAX_LOG_CHARS) };
    }

    const review = await (opts.reviewer ?? defaultSecurityReviewer).review({ dir, bounty: job.bounty, submission: job.submission });
    const t = Math.floor((opts.runOptions?.now ?? Date.now)() / 1000);
    const signed = await signReceipt(
      opts.reviewerSigner ?? opts.runnerSigner,
      {
        ...ids,
        commitHash: job.submission.commitHash,
        receiptType: "SecurityReviewReceipt",
        runnerVersion: `${runnerVersion}+${review.reviewer}`,
        result: review.passed,
        timestamp: t,
        expiry: t + (opts.runOptions?.receiptTtlSec ?? 24 * 3600),
      },
      opts.signing,
    );
    return { receipts: [toApiReceipt(signed)], logs: truncateLog(review.report, MAX_LOG_CHARS) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
