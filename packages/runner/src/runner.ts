import { chmod, cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex, Receipt, ReceiptType } from "@abm/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import { testDigest, truncateLog } from "./digest.js";
import { DEFAULT_IMAGE, DockerExecutor } from "./docker.js";
import type { ExecResult, SandboxExecutor, SandboxLimits } from "./sandbox.js";
import { DEFAULT_LIMITS } from "./sandbox.js";
import { loadSignerFromEnv, signReceipt, type SignedReceipt, type SigningContext } from "./signer.js";

export interface SubmissionInput {
  bountyId: string;
  submissionId: string;
  /** Host path of the fixed repository snapshot. Never mounted directly. */
  snapshotPath: string;
  commitHash: string;
  /** From the locked bounty spec, never from the agent. */
  buildCommand: string;
  testCommand: string;
  runnerVersion: string;
}

export interface RunOptions {
  signing: SigningContext;
  /** Defaults to the key in RUNNER_SIGNER_PRIVATE_KEY. */
  signer?: PrivateKeyAccount;
  executor?: SandboxExecutor;
  image?: string;
  limits?: Partial<SandboxLimits>;
  buildTimeoutMs?: number;
  testTimeoutMs?: number;
  /** Receipt validity window. */
  receiptTtlSec?: number;
  /** Max characters kept per log stream in the result. */
  maxLogChars?: number;
  now?: () => number;
}

export type StepStatus = "passed" | "failed" | "timeout" | "skipped";

export interface StepResult {
  status: StepStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Captured output hit the byte cap. */
  outputTruncated: boolean;
}

export interface RunResult {
  bountyId: string;
  submissionId: string;
  commitHash: string;
  build: StepResult;
  test: StepResult;
  /** sha256 of normalized test output; null when tests didn't run. */
  testDigest: Hex | null;
  receipts: SignedReceipt[];
}

export const DEFAULT_BUILD_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TEST_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_RECEIPT_TTL_SEC = 24 * 60 * 60;
export const DEFAULT_MAX_LOG_CHARS = 16_000;

/** Ids are the contract's uint256 bounty/submission ids. */
const UINT_RE = /^[0-9]{1,78}$/;
/** Full git commit id (SHA-1 or SHA-256); it becomes the onchain bytes32. */
const COMMIT_RE = /^(0x)?([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const VERSION_RE = /^[A-Za-z0-9._:+-]{1,64}$/;

export function validateInput(input: SubmissionInput): void {
  if (!UINT_RE.test(input.bountyId)) throw new Error("invalid bountyId");
  if (!UINT_RE.test(input.submissionId)) throw new Error("invalid submissionId");
  if (!COMMIT_RE.test(input.commitHash)) throw new Error("invalid commitHash");
  if (!VERSION_RE.test(input.runnerVersion)) throw new Error("invalid runnerVersion");
  if (!input.buildCommand.trim()) throw new Error("buildCommand is empty");
  if (!input.testCommand.trim()) throw new Error("testCommand is empty");
}

const SKIPPED: StepResult = { status: "skipped", exitCode: null, durationMs: 0, stdout: "", stderr: "", outputTruncated: false };

function toStep(res: ExecResult, maxLogChars: number): StepResult {
  return {
    status: res.timedOut ? "timeout" : res.exitCode === 0 ? "passed" : "failed",
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    stdout: truncateLog(res.stdout, maxLogChars),
    stderr: truncateLog(res.stderr, maxLogChars),
    outputTruncated: res.truncated,
  };
}

/** Copies the snapshot to a private temp dir the sandbox user can read. */
async function stageSnapshot(snapshotPath: string): Promise<string> {
  const s = await stat(snapshotPath);
  if (!s.isDirectory()) throw new Error("snapshotPath is not a directory");
  const dir = await mkdtemp(join(tmpdir(), "abm-snapshot-"));
  await cp(snapshotPath, dir, { recursive: true, verbatimSymlinks: true });
  await makeReadable(dir);
  return dir;
}

async function makeReadable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await makeReadable(p);
    else if (entry.isFile()) await chmod(p, ((await stat(p)).mode & 0o777) | 0o444);
  }
}

/**
 * Builds and tests one submission in an isolated sandbox, then signs a
 * receipt for each step that ran. Tests are skipped if the build fails.
 */
export async function runSubmission(input: SubmissionInput, opts: RunOptions): Promise<RunResult> {
  validateInput(input);
  const signer = opts.signer ?? loadSignerFromEnv();
  const executor = opts.executor ?? new DockerExecutor();
  const buildTimeoutMs = opts.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const testTimeoutMs = opts.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const maxLogChars = opts.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
  const now = opts.now ?? Date.now;

  const snapshotDir = await stageSnapshot(input.snapshotPath);
  let build: StepResult = SKIPPED;
  let test: StepResult = SKIPPED;
  let digest: Hex | null = null;
  try {
    const session = await executor.start({
      image: opts.image ?? DEFAULT_IMAGE,
      snapshotDir,
      limits: { ...DEFAULT_LIMITS, ...opts.limits },
      lifetimeMs: buildTimeoutMs + testTimeoutMs + 120_000,
    });
    try {
      build = toStep(await session.exec(input.buildCommand, buildTimeoutMs), maxLogChars);
      if (build.status === "passed") {
        const raw = await session.exec(input.testCommand, testTimeoutMs);
        test = toStep(raw, maxLogChars);
        digest = testDigest(raw.stdout, raw.stderr);
      }
    } finally {
      await session.destroy();
    }
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }

  const timestamp = Math.floor(now() / 1000);
  const expiry = timestamp + (opts.receiptTtlSec ?? DEFAULT_RECEIPT_TTL_SEC);
  const receipt = (receiptType: ReceiptType, result: boolean): Receipt => ({
    bountyId: input.bountyId,
    submissionId: input.submissionId,
    commitHash: input.commitHash,
    receiptType,
    runnerVersion: input.runnerVersion,
    result,
    timestamp,
    expiry,
  });

  const receipts: SignedReceipt[] = [await signReceipt(signer, receipt("BuildReceipt", build.status === "passed"), opts.signing)];
  if (test.status !== "skipped") {
    receipts.push(await signReceipt(signer, receipt("TestReceipt", test.status === "passed"), opts.signing));
  }

  return {
    bountyId: input.bountyId,
    submissionId: input.submissionId,
    commitHash: input.commitHash,
    build,
    test,
    testDigest: digest,
    receipts,
  };
}
