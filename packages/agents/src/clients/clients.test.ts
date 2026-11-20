import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiSubmission, CheckStatus } from "@abm/shared";
import { ApiClientError, createServer, type BountyApi } from "@abm/mcp";
import { connectBountyMcp } from "./mcp";
import { BROKEN_FILES, runAdversarial, runBroken } from "./scripted";
import { packSource } from "./source";

const fakePack = (() => {
  let n = 0;
  return async () => ({ commitHash: (++n).toString(16).padStart(40, "a"), sourceTarballBase64: "H4sIAAAAAAAAAw==" });
})();

const PAYOUT = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";

/**
 * A small in-memory API with the real workflow guards that matter for these scripts.
 * `autoRun` mimics AUTO_RUN=1: the test run starts on submit and finishes on the next status poll.
 */
function fakeApi(testResult: CheckStatus = "failed", autoRun = false) {
  const subs = new Map<string, ApiSubmission>();
  let seq = 0;
  const api: BountyApi = {
    listBounties: async () => [],
    getBounty: async () => {
      throw new ApiClientError(404, "not_found", "nope");
    },
    getRepository: async (id) => ({ bountyId: id, repoUrl: null, repoRef: null, testCommand: "npm test", allowNetwork: false }),
    createSubmission: async (bountyId, body) => {
      const s = {
        id: `sub_${++seq}`,
        bountyId,
        agentId: body.agentId,
        commitHash: body.commitHash,
        payoutAddress: body.payoutAddress,
        onchainId: null,
        submitTxHash: null,
        acceptTxHash: null,
        state: "CODE_SUBMITTED",
        checks: autoRun
          ? { build: "running", test: "running", security: "pending" }
          : { build: "pending", test: "pending", security: "pending" },
      } as ApiSubmission;
      subs.set(s.id, s);
      return s;
    },
    getSubmission: async (id) => {
      const s = subs.get(id)!;
      if (s.checks.test === "running") s.checks = { ...s.checks, build: "passed", test: testResult };
      return { submission: s, runs: [] };
    },
    getReceipts: async () => [],
    requestRun: async (id, kind) => {
      const s = subs.get(id)!;
      const need = kind === "test" ? "CODE_SUBMITTED" : "TESTS_VERIFIED";
      if (s.state !== need) throw new ApiClientError(409, "out_of_order", `${kind} run requires state ${need}, submission is ${s.state}`);
      if (kind === "test" && s.checks.test === "running") throw new ApiClientError(409, "run_in_progress", "a test run is already in progress");
      if (kind === "test" && s.checks.build !== "pending") throw new ApiClientError(409, "already_run", "this submission was already tested");
      if (kind === "test") s.checks = { ...s.checks, build: "passed", test: testResult };
      return { id: `run_${seq}`, submissionId: id, kind, status: "running", error: null, logs: null, startedAt: 0, finishedAt: null };
    },
  };
  return { api, subs };
}

async function connect(api: BountyApi) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(api).connect(serverT);
  return connectBountyMcp(clientT);
}

describe("adversarial client", () => {
  it("tries to skip steps and every cheat is rejected", async () => {
    const { api } = fakeApi("passed");
    const spy = vi.spyOn(api, "requestRun");
    const mcp = await connect(api);
    const report = await runAdversarial(mcp, { bountyId: "bty_demo1", payoutAddress: PAYOUT, pack: fakePack, pollMs: 1, sleep: async () => {} });

    expect(report.steps.map((s) => [s.tool, s.outcome])).toEqual([
      ["submit_code", "accepted"],
      ["request_security_review", "rejected"],
      ["accept_submission", "rejected"],
      ["submit_receipt", "rejected"],
      ["request_test_run", "accepted"],
      ["request_test_run", "rejected"],
      ["submit_code", "accepted"],
      ["request_security_review", "rejected"],
    ]);
    expect(report.ok).toBe(true);
    expect(report.steps[1]?.detail).toMatch(/out_of_order/);
    expect(report.steps[2]?.detail).toMatch(/accept_submission/);
    expect(report.steps[5]?.detail).toMatch(/already_run/);
    expect(spy.mock.calls).toEqual([
      ["sub_1", "security"],
      ["sub_1", "test"],
      ["sub_1", "test"],
      ["sub_2", "security"],
    ]);
    // Two different commits.
    const commits = mcp.calls.filter((c) => c.name === "submit_code").map((c) => c.args.commitHash);
    expect(new Set(commits).size).toBe(2);
  });

  it("sends the payout address with every submission", async () => {
    const mcp = await connect(fakeApi().api);
    await runAdversarial(mcp, { bountyId: "bty_demo1", payoutAddress: PAYOUT, pack: fakePack, pollMs: 1, sleep: async () => {} });
    const subs = mcp.calls.filter((c) => c.name === "submit_code");
    expect(subs).toHaveLength(2);
    for (const c of subs) expect(c.args.payoutAddress).toBe(PAYOUT);
  });

  it("still passes when the API auto-starts runs on submit", async () => {
    const mcp = await connect(fakeApi("passed", true).api);
    const report = await runAdversarial(mcp, { bountyId: "bty_demo1", payoutAddress: PAYOUT, pack: fakePack, pollMs: 1, sleep: async () => {} });
    expect(report.steps[4]).toMatchObject({ tool: "request_test_run", expected: "any", outcome: "rejected" });
    expect(report.steps[4]?.detail).toMatch(/run_in_progress/);
    expect(report.steps[5]).toMatchObject({ outcome: "rejected" });
    expect(report.steps[5]?.detail).toMatch(/already_run/);
    expect(report.ok).toBe(true);
  });

  it("reports a failure if a cheat gets through", async () => {
    const { api } = fakeApi("passed");
    api.requestRun = async (id, kind) => ({ id: "run_x", submissionId: id, kind, status: "running", error: null, logs: null, startedAt: 0, finishedAt: null });
    const report = await runAdversarial(await connect(api), { bountyId: "bty_demo1", payoutAddress: PAYOUT, pack: fakePack, waitMs: 3, pollMs: 1, sleep: async () => {} });
    expect(report.ok).toBe(false);
  });
});

describe("broken client", () => {
  it("submits, requests a test run, and sees the tests fail", async () => {
    const { api } = fakeApi("failed");
    const mcp = await connect(api);
    const report = await runBroken(mcp, { bountyId: "bty_demo1", payoutAddress: PAYOUT, pack: fakePack, pollMs: 1, sleep: async () => {} });
    expect(mcp.calls.map((c) => c.name)).toEqual(["submit_code", "request_test_run", "get_submission_status"]);
    expect(report.steps.at(-1)).toMatchObject({ outcome: "rejected", detail: "build=passed test=failed" });
    expect(report.ok).toBe(true);
  });

  it("handles an auto-started test run", async () => {
    const mcp = await connect(fakeApi("failed", true).api);
    const report = await runBroken(mcp, { bountyId: "bty_demo1", payoutAddress: PAYOUT, pack: fakePack, pollMs: 1, sleep: async () => {} });
    expect(report.steps[1]).toMatchObject({ expected: "any", outcome: "rejected" });
    expect(report.steps.at(-1)).toMatchObject({ outcome: "rejected", detail: "build=passed test=failed" });
    expect(report.ok).toBe(true);
  });

  it("reports unexpected success if the tests pass", async () => {
    const mcp = await connect(fakeApi("passed").api);
    const report = await runBroken(mcp, { bountyId: "bty_demo1", payoutAddress: PAYOUT, pack: fakePack, pollMs: 1, sleep: async () => {} });
    expect(report.ok).toBe(false);
  });

  it("ships code that really fails its own tests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abm-broken-test-"));
    try {
      const packed = await packSource(BROKEN_FILES);
      expect(packed.commitHash).toMatch(/^[0-9a-f]{40}$/);
      await writeFile(join(dir, "src.tar.gz"), Buffer.from(packed.sourceTarballBase64, "base64"));
      execFileSync("tar", ["-xzf", "src.tar.gz"], { cwd: dir });
      expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).scripts.test).toBe("node --test");
      expect(() => execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe", env: { PATH: process.env.PATH } })).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
