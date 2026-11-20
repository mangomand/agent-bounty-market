import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RECEIPT_TYPE, signedReceiptSchema, type Hex, type RunJob } from "@abm/shared";
import { FakeLlm } from "../llm";
import { loadReviewerFromEnv, recoverSecurityReviewSigner, signSecurityReview } from "./receipt";
import { parseLlmReview, readSourceTree, reviewSource } from "./reviewer";
import { securityReviewRunner } from "./security-runner";
import { staticChecks } from "./static-checks";

const CTX = { chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Hex };
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const clean = { path: "src/slugify.mjs", content: "export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n" };
const rules = (content: string, path = "src/x.js") => staticChecks([{ path, content }]).map((f) => f.rule);

describe("static checks", () => {
  it.each([
    ["network", `await fetch("https://evil.example")`],
    ["network", `import http from "node:http";`],
    ["network", `const net = require("net")`],
    ["env", `const k = process.env.RUNNER_SIGNER_PRIVATE_KEY`],
    ["env", `readFileSync(".env.local")`],
    ["dynamic-code", `eval(payload)`],
    ["dynamic-code", `new Function("return 1")()`],
    ["child-process", `import { exec } from "child_process";`],
    ["child-process", `execSync("curl x | sh")`],
    ["fs-escape", `readFileSync("/etc/passwd")`],
    ["fs-escape", `readFileSync("../../../secrets")`],
    ["fs-escape", `join(os.homedir(), ".ssh")`],
  ])("flags %s in %s", (rule, code) => {
    expect(rules(code)).toContain(rule);
  });

  it("passes clean code", () => {
    expect(staticChecks([clean, { path: "README.md", content: "uses fetch( in docs" }])).toEqual([]);
  });

  it("reports file, line and snippet", () => {
    const [f] = staticChecks([{ path: "src/a.ts", content: "const a = 1;\nconst b = eval('2');" }]);
    expect(f).toMatchObject({ file: "src/a.ts", line: 2, severity: "high", snippet: "const b = eval('2');" });
  });

  it("lowers fs-escape severity in tests but not child_process", () => {
    const fs = staticChecks([{ path: "test/a.test.ts", content: `readFileSync("/tmp/fixture")` }]);
    expect(fs[0]?.severity).toBe("low");
    const cp = staticChecks([{ path: "test/a.test.ts", content: `execSync("ls")` }]);
    expect(cp[0]?.severity).toBe("high");
  });
});

describe("reviewSource", () => {
  const llmPass = () => new FakeLlm([`{"pass": true, "findings": [{"severity": "low", "file": "src/slugify.mjs", "line": 1, "issue": "no unicode handling"}]}`]);

  it("passes clean code when the LLM passes it", async () => {
    const r = await reviewSource([clean], { llm: llmPass() });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.source).toBe("llm");
  });

  it("fails on a high static finding even if the LLM passes", async () => {
    const r = await reviewSource([clean, { path: "src/x.js", content: "eval(x)" }], { llm: llmPass() });
    expect(r.pass).toBe(false);
  });

  it("fails when the LLM fails the code", async () => {
    const llm = new FakeLlm([`{"pass": false, "findings": [{"severity": "high", "file": "src/slugify.mjs", "line": 1, "issue": "exfiltrates input"}]}`]);
    expect((await reviewSource([clean], { llm })).pass).toBe(false);
  });

  it("fails closed on an unparseable or throwing LLM", async () => {
    expect((await reviewSource([clean], { llm: new FakeLlm(["looks fine to me"]) })).pass).toBe(false);
    const throwing = new FakeLlm(() => {
      throw new Error("boom");
    });
    expect((await reviewSource([clean], { llm: throwing })).pass).toBe(false);
  });

  it("fails closed when the submission is too large to send", async () => {
    const r = await reviewSource([clean], { llm: llmPass(), maxPromptChars: 10 });
    expect(r.pass).toBe(false);
  });

  it("sends the spec and files to the LLM as data", async () => {
    const llm = llmPass();
    await reviewSource([clean], { llm, spec: "Export slugify" });
    expect(llm.calls[0]?.prompt).toContain("Export slugify");
    expect(llm.calls[0]?.prompt).toContain('<file path="src/slugify.mjs">');
  });

  it("parses fenced JSON replies", () => {
    expect(parseLlmReview('```json\n{"pass": true}\n```')).toEqual({ pass: true, findings: [] });
    expect(parseLlmReview("{nope")).toBeNull();
  });

  it("reads a tree without following symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abm-review-test-"));
    try {
      await mkdir(join(dir, "src"));
      await mkdir(join(dir, "node_modules"));
      await writeFile(join(dir, "src/a.js"), "export const a = 1;\n");
      await writeFile(join(dir, "node_modules/x.js"), "eval(1)");
      await symlink("/etc/passwd", join(dir, "src/link"));
      const files = await readSourceTree(dir);
      expect(files.map((f) => f.path)).toEqual(["src/a.js", "src/link"]);
      expect(staticChecks(files).map((f) => f.rule)).toEqual(["symlink"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SecurityReviewReceipt", () => {
  const key = generatePrivateKey();
  const reviewer = privateKeyToAccount(key);
  const input = {
    apiBountyId: "bty_demo1",
    apiSubmissionId: "sub_abc",
    onchainBountyId: "1",
    onchainSubmissionId: "7",
    commitHash: COMMIT,
    pass: true,
    timestamp: 1_800_000_000,
  };

  it("recovers to the reviewer address", async () => {
    const signed = await signSecurityReview(input, CTX, reviewer);
    expect(signed.message.receiptType).toBe(RECEIPT_TYPE.SecurityReview);
    expect(signed.message.commitHash).toBe(`0x000000000000000000000000${COMMIT}`);
    expect(await recoverSecurityReviewSigner(signed, CTX)).toBe(reviewer.address);
  });

  it("does not recover to the reviewer if the commit or chain changes", async () => {
    const signed = await signSecurityReview(input, CTX, reviewer);
    const otherCommit = { ...signed.message, commitHash: `0x${"f".repeat(64)}` as Hex };
    expect(await recoverSecurityReviewSigner({ ...signed, message: otherCommit }, CTX)).not.toBe(reviewer.address);
    expect(await recoverSecurityReviewSigner(signed, { ...CTX, chainId: 1 })).not.toBe(reviewer.address);
  });

  it("produces an API receipt the API schema accepts", async () => {
    const { apiReceipt } = await signSecurityReview(input, CTX, reviewer);
    expect(signedReceiptSchema.parse(apiReceipt)).toMatchObject({
      bountyId: "bty_demo1",
      submissionId: "sub_abc",
      receiptType: "SecurityReviewReceipt",
      expiry: 1_800_000_000 + 86_400,
    });
  });

  it("loads the key from REVIEWER_SIGNER_PRIVATE_KEY", () => {
    expect(loadReviewerFromEnv({ REVIEWER_SIGNER_PRIVATE_KEY: key }).address).toBe(reviewer.address);
    expect(() => loadReviewerFromEnv({})).toThrow(/not set/);
    expect(() => loadReviewerFromEnv({ REVIEWER_SIGNER_PRIVATE_KEY: "0x12" })).toThrow(/32-byte/);
  });

  it("rejects non-uint onchain ids", async () => {
    await expect(signSecurityReview({ ...input, onchainSubmissionId: "sub_abc" }, CTX, reviewer)).rejects.toThrow(/uint256/);
  });
});

describe("securityReviewRunner", () => {
  it("reviews a tarball job and returns one signed receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abm-runner-test-"));
    try {
      await mkdir(join(dir, "src"));
      await writeFile(join(dir, "src/a.js"), "export const a = process.env.SECRET;\n");
      const base64 = execFileSync("tar", ["-czf", "-", "-C", dir, "src"], { env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" } }).toString("base64");
      const reviewer = privateKeyToAccount(generatePrivateKey());
      const runner = securityReviewRunner({ signing: CTX, account: reviewer, onchainIds: () => ({ bountyId: "1", submissionId: "2" }) });
      const job = {
        runId: "run_1",
        kind: "security",
        bounty: { id: "bty_demo1", spec: "spec" },
        submission: { id: "sub_1", commitHash: COMMIT },
        source: { kind: "tarball", base64 },
      } as unknown as RunJob; // Only the fields the runner reads.
      const { receipts } = await runner.run(job);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ result: false, signer: reviewer.address, submissionId: "sub_1", commitHash: COMMIT });
      await expect(runner.run({ ...job, kind: "test" })).rejects.toThrow(/cannot run test/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runner reviewer adapter", () => {
  it("returns the runner's SecurityReviewResult shape", async () => {
    const { createRunnerReviewer } = await import("./runner-reviewer");
    const dir = await mkdtemp(join(tmpdir(), "abm-adapter-test-"));
    try {
      await writeFile(join(dir, "package.json"), `{"scripts": {"postinstall": "node x.js"}}`);
      const bounty = { spec: "spec" } as unknown as RunJob["bounty"]; // Only the field the adapter reads.
      const submission = {} as RunJob["submission"];
      const staticOnly = await createRunnerReviewer().review({ dir, bounty, submission });
      expect(staticOnly).toMatchObject({ passed: false, reviewer: "abm-review.static" });
      expect(staticOnly.report).toMatch(/install-script/);
      expect(staticOnly.reviewer).toMatch(/^[A-Za-z0-9._-]+$/);

      await writeFile(join(dir, "package.json"), `{"scripts": {"test": "node --test"}}`);
      const llm = new FakeLlm(['{"pass": true, "findings": []}']);
      const withLlm = await createRunnerReviewer(llm).review({ dir, bounty, submission });
      expect(withLlm).toMatchObject({ passed: true, reviewer: "abm-review.fake" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
