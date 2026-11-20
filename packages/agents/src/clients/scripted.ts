import type { BountyMcp, ToolOutcome } from "./mcp";
import { packSource, type PackedSource } from "./source";

/**
 * Scripted demo clients. No LLM: they drive the public MCP tools in a fixed order so the
 * demo can show the workflow rejecting bad behaviour next to a real Claude Code run.
 */

export type Expectation = "accepted" | "rejected";

export interface ScriptStep {
  name: string;
  tool: string;
  expected: Expectation;
  outcome: Expectation;
  detail: string;
}

export interface ScriptReport {
  client: "adversarial" | "broken";
  bountyId: string;
  steps: ScriptStep[];
  /** True when every step behaved as the demo expects. */
  ok: boolean;
}

export interface ScriptOptions {
  bountyId: string;
  agentId?: string;
  /** Sent with submit_code only when set (the MCP schema must accept it). */
  payoutAddress?: string;
  /** Wait for the test run to finish (broken client). Default 120 s. 0 skips waiting. */
  waitMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  /** Injectable for tests. */
  pack?: (files: Record<string, string>, message: string) => Promise<PackedSource>;
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);

const SLUGIFY_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.mjs";

test("slugify", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Trim  me!  "), "trim-me");
});
`;

const PACKAGE_JSON = JSON.stringify({ name: "submission", type: "module", private: true, scripts: { test: "node --test" } }, null, 2);

const GOOD_FILES = {
  "package.json": PACKAGE_JSON,
  "src/slugify.mjs": `export function slugify(input) {
  return input.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`,
  "test/slugify.test.mjs": SLUGIFY_TEST,
};

/** Returns input unchanged, so the tests fail. */
export const BROKEN_FILES = {
  ...GOOD_FILES,
  "src/slugify.mjs": `export function slugify(input) {
  return input;
}
`,
};

class Script {
  readonly steps: ScriptStep[] = [];
  constructor(
    readonly mcp: BountyMcp,
    readonly log: (line: string) => void,
  ) {}

  async step(name: string, tool: string, args: Record<string, unknown>, expected: Expectation): Promise<ToolOutcome> {
    const out = await this.mcp.call(tool, args);
    const outcome: Expectation = out.ok ? "accepted" : "rejected";
    const detail = out.ok ? short(JSON.stringify(out.data)) : short(out.text);
    this.steps.push({ name, tool, expected, outcome, detail });
    const mark = outcome === expected ? "ok" : "UNEXPECTED";
    this.log(`[${mark}] ${name}: ${outcome}${out.ok ? "" : ` (${detail})`}`);
    return out;
  }
}

function submissionId(out: ToolOutcome): string {
  const id = (out.data as { id?: unknown } | null)?.id;
  if (!out.ok || typeof id !== "string") throw new Error(`submit_code failed: ${out.text}`);
  return id;
}

function submitArgs(opts: ScriptOptions, agentId: string, src: PackedSource): Record<string, unknown> {
  return {
    bountyId: opts.bountyId,
    agentId,
    commitHash: src.commitHash,
    sourceTarballBase64: src.sourceTarballBase64,
    ...(opts.payoutAddress ? { payoutAddress: opts.payoutAddress } : {}),
  };
}

/**
 * Tries to cheat the workflow. Every step after the first submission should be rejected:
 * 1. security review before tests (skips BUILD/TESTS_VERIFIED)
 * 2. calling a settlement tool that the MCP server does not expose
 * 3. running tests twice on one commit (replaying the test step)
 * 4. a new commit that tries to ride on the first commit's test run
 */
export async function runAdversarial(mcp: BountyMcp, opts: ScriptOptions): Promise<ScriptReport> {
  const log = opts.log ?? (() => {});
  const pack = opts.pack ?? packSource;
  const agentId = opts.agentId ?? "adversarial";
  const s = new Script(mcp, log);

  const first = await pack(GOOD_FILES, "honest-looking first commit");
  const subA = submissionId(await s.step("submit commit A", "submit_code", submitArgs(opts, agentId, first), "accepted"));

  await s.step("security review before tests", "request_security_review", { submissionId: subA }, "rejected");
  await s.step("request payout directly", "accept_submission", { submissionId: subA }, "rejected");
  await s.step("post own receipt", "submit_receipt", { submissionId: subA, receiptType: "TestReceipt", result: true }, "rejected");

  await s.step("test run for commit A", "request_test_run", { submissionId: subA }, "accepted");
  await s.step("second test run for commit A", "request_test_run", { submissionId: subA }, "rejected");

  const second = await pack({ ...GOOD_FILES, "src/extra.mjs": "export const extra = 1;\n" }, "swap in commit B");
  const subB = submissionId(await s.step("submit commit B", "submit_code", submitArgs(opts, agentId, second), "accepted"));
  await s.step("security review for B using A's tests", "request_security_review", { submissionId: subB }, "rejected");

  return { client: "adversarial", bountyId: opts.bountyId, steps: s.steps, ok: s.steps.every((x) => x.expected === x.outcome) };
}

type Checks = { build?: string; test?: string };
const DONE = new Set(["passed", "failed", "error"]);

/** Submits code whose tests fail, starts the test run, and waits for the failed result. */
export async function runBroken(mcp: BountyMcp, opts: ScriptOptions): Promise<ScriptReport> {
  const log = opts.log ?? (() => {});
  const pack = opts.pack ?? packSource;
  const sleep = opts.sleep ?? sleepReal;
  const waitMs = opts.waitMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2_000;
  const s = new Script(mcp, log);

  const src = await pack(BROKEN_FILES, "slugify (untested)");
  const sub = submissionId(await s.step("submit broken code", "submit_code", submitArgs(opts, opts.agentId ?? "broken", src), "accepted"));
  await s.step("request test run", "request_test_run", { submissionId: sub }, "accepted");

  let ok = true;
  if (waitMs > 0) {
    let checks: Checks = {};
    for (let waited = 0; waited <= waitMs; waited += pollMs) {
      const out = await mcp.call("get_submission_status", { submissionId: sub });
      checks = (out.data as { submission?: { checks?: Checks } } | null)?.submission?.checks ?? {};
      if (checks.build === "failed" || checks.build === "error" || DONE.has(checks.test ?? "")) break;
      await sleep(pollMs);
    }
    const failed = checks.build === "failed" || checks.test === "failed";
    const outcome: Expectation = failed ? "rejected" : "accepted";
    const detail = `build=${checks.build ?? "?"} test=${checks.test ?? "?"}`;
    s.steps.push({ name: "sandbox test result", tool: "get_submission_status", expected: "rejected", outcome, detail });
    log(`[${failed ? "ok" : "UNEXPECTED"}] sandbox test result: ${detail}`);
    ok = failed;
  }
  return { client: "broken", bountyId: opts.bountyId, steps: s.steps, ok: ok && s.steps.every((x) => x.expected === x.outcome) };
}
