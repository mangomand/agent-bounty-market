import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDigest } from "./digest.js";
import { runCommand } from "./process.js";
import { runSubmission, type SubmissionInput } from "./runner.js";
import type { ExecResult, SandboxExecutor, SandboxSpec } from "./sandbox.js";
import { recoverReceiptSigner } from "./signer.js";

const signing = { chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" } as const;
const signer = privateKeyToAccount(generatePrivateKey());

type Script = Record<string, Partial<ExecResult>>;

/** Fake backend: returns scripted results per command and records what it saw. */
class FakeExecutor implements SandboxExecutor {
  specs: SandboxSpec[] = [];
  commands: string[] = [];
  destroyed = 0;
  snapshotContents: string | undefined;
  constructor(private readonly script: Script) {}
  async start(spec: SandboxSpec) {
    this.specs.push(spec);
    this.snapshotContents = await readFile(join(spec.snapshotDir, "index.js"), "utf8");
    return {
      exec: async (command: string, timeoutMs: number): Promise<ExecResult> => {
        this.commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: timeoutMs > 0 ? 5 : 0, ...this.script[command] };
      },
      destroy: async () => {
        this.destroyed++;
      },
    };
  }
}

let snapshot: string;
const input = (): SubmissionInput => ({
  bountyId: "7",
  submissionId: "42",
  snapshotPath: snapshot,
  commitHash: "0123456789abcdef0123456789abcdef01234567",
  buildCommand: "npm run build",
  testCommand: "npm test",
  runnerVersion: "runner-0.1.0",
});

beforeAll(async () => {
  snapshot = await mkdtemp(join(tmpdir(), "abm-test-repo-"));
  await writeFile(join(snapshot, "index.js"), "console.log('hi')\n");
});
afterAll(async () => {
  await rm(snapshot, { recursive: true, force: true });
});

describe("runSubmission with a fake executor", () => {
  it("signs passing build and test receipts bound to the commit", async () => {
    const fake = new FakeExecutor({ "npm test": { stdout: "\u001b[32m3 passed\u001b[0m\r\n" } });
    const res = await runSubmission(input(), { signing, signer, executor: fake, now: () => 1_800_000_000_000, receiptTtlSec: 600 });

    expect(fake.commands).toEqual(["npm run build", "npm test"]);
    expect(fake.destroyed).toBe(1);
    expect(fake.specs[0]?.snapshotDir).not.toBe(snapshot);
    expect(fake.snapshotContents).toBe("console.log('hi')\n");
    expect(res.build.status).toBe("passed");
    expect(res.test.status).toBe("passed");
    expect(res.testDigest).toBe(testDigest("3 passed", ""));

    expect(res.receipts.map((r) => [r.receipt.receiptType, r.receipt.result])).toEqual([
      ["BuildReceipt", true],
      ["TestReceipt", true],
    ]);
    for (const r of res.receipts) {
      expect(r.receipt).toMatchObject({ bountyId: "7", submissionId: "42", commitHash: input().commitHash, timestamp: 1_800_000_000, expiry: 1_800_000_600 });
      expect(r.message).toMatchObject({ bountyId: 7n, submissionId: 42n, commitHash: `0x${"0".repeat(24)}${input().commitHash}` });
      expect(await recoverReceiptSigner(r, signing)).toBe(signer.address);
    }
  });

  it("signs a failing test receipt", async () => {
    const fake = new FakeExecutor({ "npm test": { exitCode: 1, stderr: "1 failed" } });
    const res = await runSubmission(input(), { signing, signer, executor: fake });
    expect(res.test).toMatchObject({ status: "failed", exitCode: 1, stderr: "1 failed" });
    expect(res.receipts.map((r) => r.receipt.result)).toEqual([true, false]);
  });

  it("skips tests and emits only a failed build receipt when the build fails", async () => {
    const fake = new FakeExecutor({ "npm run build": { exitCode: 2, stderr: "tsc error" } });
    const res = await runSubmission(input(), { signing, signer, executor: fake });
    expect(fake.commands).toEqual(["npm run build"]);
    expect(res.test.status).toBe("skipped");
    expect(res.testDigest).toBeNull();
    expect(res.receipts).toHaveLength(1);
    expect(res.receipts[0]?.receipt).toMatchObject({ receiptType: "BuildReceipt", result: false });
  });

  it("treats a timed-out test run as a failure", async () => {
    const fake = new FakeExecutor({ "npm test": { exitCode: null, timedOut: true } });
    const res = await runSubmission(input(), { signing, signer, executor: fake, testTimeoutMs: 10 });
    expect(res.test.status).toBe("timeout");
    expect(res.receipts[1]?.receipt.result).toBe(false);
    expect(fake.destroyed).toBe(1);
  });

  it("truncates long logs", async () => {
    const fake = new FakeExecutor({ "npm test": { stdout: "x".repeat(5000) } });
    const res = await runSubmission(input(), { signing, signer, executor: fake, maxLogChars: 100 });
    expect(res.test.stdout.length).toBeLessThan(200);
    expect(res.test.stdout).toMatch(/truncated/);
  });

  it("rejects bad input before touching the sandbox", async () => {
    const fake = new FakeExecutor({});
    await expect(runSubmission({ ...input(), commitHash: "main; rm -rf /" }, { signing, signer, executor: fake })).rejects.toThrow(/commitHash/);
    await expect(runSubmission({ ...input(), bountyId: "../x" }, { signing, signer, executor: fake })).rejects.toThrow(/bountyId/);
    await expect(runSubmission({ ...input(), submissionId: "sub-42" }, { signing, signer, executor: fake })).rejects.toThrow(/submissionId/);
    await expect(runSubmission({ ...input(), commitHash: "0123abc" }, { signing, signer, executor: fake })).rejects.toThrow(/commitHash/);
    expect(fake.specs).toHaveLength(0);
  });

  it("cleans up the sandbox when exec throws", async () => {
    let destroyed = false;
    const executor: SandboxExecutor = {
      start: async () => ({
        exec: async () => {
          throw new Error("daemon gone");
        },
        destroy: async () => {
          destroyed = true;
        },
      }),
    };
    await expect(runSubmission(input(), { signing, signer, executor })).rejects.toThrow(/daemon gone/);
    expect(destroyed).toBe(true);
  });
});

describe("runCommand", () => {
  it("kills a process that exceeds its timeout", async () => {
    const res = await runCommand("sh", ["-c", "sleep 5"], { timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(2000);
  });

  it("captures exit code and caps output", async () => {
    const res = await runCommand("sh", ["-c", "printf 'abcdefghij'; exit 3"], { timeoutMs: 5000, maxOutputBytes: 4 });
    expect(res).toMatchObject({ exitCode: 3, stdout: "abcd", truncated: true, timedOut: false });
  });

  it("does not leak the signing key to child processes", async () => {
    process.env.RUNNER_SIGNER_PRIVATE_KEY = "0xshould-not-leak";
    try {
      const res = await runCommand("sh", ["-c", "echo \"[$RUNNER_SIGNER_PRIVATE_KEY]\""], { timeoutMs: 5000 });
      expect(res.stdout.trim()).toBe("[]");
    } finally {
      delete process.env.RUNNER_SIGNER_PRIVATE_KEY;
    }
  });
});
