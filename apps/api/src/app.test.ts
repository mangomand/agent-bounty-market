import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiEvent, RunJob, RunnerClient, SignedReceipt } from "@abm/shared";
import { createApp } from "./app";
import { openDb } from "./db";
import { seed } from "./seed";

const NOW = 1_800_000_000;
const CREATOR = "0x1111111111111111111111111111111111111111";
const SIGNER = "0x2222222222222222222222222222222222222222";
const COMMIT = "a".repeat(40);
const H = (c: string) => `0x${c.repeat(64)}`;
let sigCounter = 0;
const sig = () => `0x${(++sigCounter).toString(16).padStart(130, "0")}`;

function receipt(job: { bountyId: string; submissionId: string }, type: SignedReceipt["receiptType"], result = true, over: Partial<SignedReceipt> = {}): SignedReceipt {
  return {
    bountyId: job.bountyId,
    submissionId: job.submissionId,
    commitHash: COMMIT,
    receiptType: type,
    runnerVersion: "test-1",
    result,
    timestamp: NOW,
    expiry: NOW + 3600,
    signature: sig() as SignedReceipt["signature"],
    signer: SIGNER,
    ...over,
  };
}

/** Fake runner: test runs pass build+test, security runs pass security. */
function fakeRunner(opts: { fail?: boolean } = {}): RunnerClient & { jobs: RunJob[] } {
  const jobs: RunJob[] = [];
  return {
    jobs,
    async run(job) {
      jobs.push(job);
      if (opts.fail) throw new Error("sandbox exploded");
      const ids = { bountyId: job.bounty.id, submissionId: job.submission.id };
      return job.kind === "test"
        ? { receipts: [receipt(ids, "BuildReceipt"), receipt(ids, "TestReceipt")] }
        : { receipts: [receipt(ids, "SecurityReviewReceipt")] };
    },
  };
}

function setup(runner: RunnerClient = fakeRunner()) {
  const db = openDb(":memory:");
  const ctx = createApp({ db, runner, runnerSigners: [SIGNER], now: () => NOW });
  const events: ApiEvent[] = [];
  ctx.events.on("event", (e: ApiEvent) => events.push(e));
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await ctx.app.request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper; responses are asserted field by field
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ...ctx, db, req, events };
}

const bountyBody = {
  title: "Slugify",
  spec: "do the thing",
  specHash: H("1"),
  testSuiteHash: H("2"),
  amountUsdc: "50",
  deadline: NOW + 1000,
  creator: CREATOR,
};

async function withSubmission(t: ReturnType<typeof setup>) {
  const b = await t.req("POST", "/bounties", bountyBody);
  const s = await t.req("POST", `/bounties/${b.body.bounty.id}/submissions`, {
    agentId: "agent-1",
    commitHash: COMMIT,
    repoUrl: "https://github.com/x/y",
  });
  expect(s.status).toBe(201);
  return { bountyId: b.body.bounty.id as string, submissionId: s.body.submission.id as string };
}

describe("bounties", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));

  it("creates, lists and gets", async () => {
    const created = await t.req("POST", "/bounties", bountyBody);
    expect(created.status).toBe(201);
    expect(created.body.bounty).toMatchObject({ title: "Slugify", state: "OPEN", amountUsdc: "50", submissionCount: 0, testCommand: "npm test" });
    const list = await t.req("GET", "/bounties");
    expect(list.body.bounties).toHaveLength(1);
    const one = await t.req("GET", `/bounties/${created.body.bounty.id}`);
    expect(one.body.bounty.id).toBe(created.body.bounty.id);
    expect(t.events.map((e) => e.type)).toEqual(["bounty.created"]);
  });

  it("validates input", async () => {
    const bad = await t.req("POST", "/bounties", { ...bountyBody, specHash: "nope", amountUsdc: "-1" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
    expect((await t.req("POST", "/bounties", { ...bountyBody, deadline: NOW - 1 })).status).toBe(400);
    expect((await t.req("GET", "/bounties/../etc")).status).toBe(404);
    expect((await t.req("GET", "/bounties/bty_missing")).status).toBe(404);
    expect((await t.req("GET", "/bounties/not-an-id")).status).toBe(400);
  });

  it("rejects duplicate onchain ids", async () => {
    expect((await t.req("POST", "/bounties", { ...bountyBody, onchainId: "7" })).status).toBe(201);
    expect((await t.req("POST", "/bounties", { ...bountyBody, onchainId: "7" })).status).toBe(409);
  });

  it("seeds demo bounties idempotently", async () => {
    expect(seed(t.db, NOW)).toBe(3);
    expect(seed(t.db, NOW)).toBe(0);
    const list = await t.req("GET", "/bounties");
    expect(list.body.bounties.map((b: { id: string }) => b.id)).toEqual(["bty_demo3", "bty_demo2", "bty_demo1"]);
  });
});

describe("submissions", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));

  it("creates from a repo URL and lists by bounty", async () => {
    const { bountyId, submissionId } = await withSubmission(t);
    const list = await t.req("GET", `/bounties/${bountyId}/submissions`);
    expect(list.body.submissions).toHaveLength(1);
    const one = await t.req("GET", `/submissions/${submissionId}`);
    expect(one.body.submission).toMatchObject({
      state: "CODE_SUBMITTED",
      source: { kind: "git", repoUrl: "https://github.com/x/y" },
      checks: { build: "pending", test: "pending", security: "pending" },
    });
    expect((await t.req("GET", `/bounties/${bountyId}`)).body.bounty.submissionCount).toBe(1);
  });

  it("accepts a gzip tarball and rejects non-gzip", async () => {
    const b = await t.req("POST", "/bounties", bountyBody);
    const path = `/bounties/${b.body.bounty.id}/submissions`;
    const ok = await t.req("POST", path, { agentId: "a", commitHash: COMMIT, sourceTarballBase64: gzipSync("hi").toString("base64") });
    expect(ok.status).toBe(201);
    expect(ok.body.submission.source.kind).toBe("tarball");
    const bad = await t.req("POST", path, { agentId: "a", commitHash: COMMIT, sourceTarballBase64: Buffer.from("hi").toString("base64") });
    expect(bad.status).toBe(400);
  });

  it("requires exactly one source and a valid commit", async () => {
    const b = await t.req("POST", "/bounties", bountyBody);
    const path = `/bounties/${b.body.bounty.id}/submissions`;
    expect((await t.req("POST", path, { agentId: "a", commitHash: COMMIT })).status).toBe(400);
    expect((await t.req("POST", path, { agentId: "a", commitHash: "xyz", repoUrl: "https://g.com/r" })).status).toBe(400);
    expect((await t.req("POST", path, { agentId: "a", commitHash: COMMIT, repoUrl: "file:///etc/passwd" })).status).toBe(400);
    expect((await t.req("POST", path, { agentId: "a b", commitHash: COMMIT, repoUrl: "https://g.com/r" })).status).toBe(400);
  });
});

describe("runs and receipts", () => {
  it("runs the full workflow through to payout", async () => {
    const runner = fakeRunner();
    const t = setup(runner);
    const ids = await withSubmission(t);

    expect((await t.req("POST", `/submissions/${ids.submissionId}/runs`, { kind: "security" })).body.error.code).toBe("out_of_order");
    const run = await t.req("POST", `/submissions/${ids.submissionId}/runs`, { kind: "test" });
    expect(run.status).toBe(202);
    await t.idle();
    expect(runner.jobs[0]?.source).toEqual({ kind: "git", repoUrl: "https://github.com/x/y", commitHash: COMMIT });
    let sub = (await t.req("GET", `/submissions/${ids.submissionId}`)).body;
    expect(sub.submission.state).toBe("TESTS_VERIFIED");
    expect(sub.runs[0].status).toBe("finished");

    await t.req("POST", `/submissions/${ids.submissionId}/runs`, { kind: "security" });
    await t.idle();
    sub = (await t.req("GET", `/submissions/${ids.submissionId}`)).body;
    expect(sub.submission.state).toBe("SECURITY_REVIEWED");
    expect(sub.submission.checks).toEqual({ build: "passed", test: "passed", security: "passed" });

    const receipts = await t.req("GET", `/submissions/${ids.submissionId}/receipts`);
    expect(receipts.body.receipts.map((r: { receiptType: string }) => r.receiptType)).toEqual([
      "BuildReceipt", "TestReceipt", "SecurityReviewReceipt",
    ]);

    const notCreator = await t.req("POST", `/submissions/${ids.submissionId}/accept`, { creator: SIGNER, txHash: H("f") });
    expect(notCreator.status).toBe(403);
    const accepted = await t.req("POST", `/submissions/${ids.submissionId}/accept`, { creator: CREATOR, txHash: H("f") });
    expect(accepted.status).toBe(200);
    expect(accepted.body.submission).toMatchObject({ state: "PAYOUT", acceptTxHash: H("f") });
    expect(accepted.body.bounty).toMatchObject({ state: "AWARDED", acceptedSubmissionId: ids.submissionId, payoutTxHash: H("f") });
    expect((await t.req("POST", `/submissions/${ids.submissionId}/accept`, { creator: CREATOR, txHash: H("e") })).status).toBe(409);

    const types = t.events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("receipt.created");
    expect(types.at(-1)).toBe("bounty.updated");
  });

  it("refuses to accept before the workflow is complete", async () => {
    const t = setup();
    const ids = await withSubmission(t);
    const r = await t.req("POST", `/submissions/${ids.submissionId}/accept`, { creator: CREATOR, txHash: H("f") });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("out_of_order");
  });

  it("marks checks errored when the runner fails", async () => {
    const t = setup(fakeRunner({ fail: true }));
    const ids = await withSubmission(t);
    await t.req("POST", `/submissions/${ids.submissionId}/runs`, { kind: "test" });
    await t.idle();
    const sub = (await t.req("GET", `/submissions/${ids.submissionId}`)).body;
    expect(sub.submission.state).toBe("CODE_SUBMITTED");
    expect(sub.submission.checks.build).toBe("error");
    expect(sub.runs[0]).toMatchObject({ status: "error", error: "sandbox exploded" });
  });

  it("records a failed build without advancing", async () => {
    const t = setup();
    const ids = await withSubmission(t);
    const r = await t.req("POST", `/submissions/${ids.submissionId}/receipts`, { receipts: [receipt(ids, "BuildReceipt", false)] });
    expect(r.status).toBe(201);
    const sub = (await t.req("GET", `/submissions/${ids.submissionId}`)).body.submission;
    expect(sub).toMatchObject({ state: "CODE_SUBMITTED", checks: { build: "failed" } });
  });

  describe("rejects bad receipts", () => {
    const cases: [string, (ids: { bountyId: string; submissionId: string }) => SignedReceipt[], number, string][] = [
      ["wrong commit", (ids) => [receipt(ids, "BuildReceipt", true, { commitHash: "b".repeat(40) })], 422, "wrong_commit"],
      ["expired", (ids) => [receipt(ids, "BuildReceipt", true, { expiry: NOW })], 422, "expired"],
      ["unapproved signer", (ids) => [receipt(ids, "BuildReceipt", true, { signer: CREATOR })], 403, "unapproved_signer"],
      ["skipped state", (ids) => [receipt(ids, "TestReceipt")], 409, "out_of_order"],
      ["wrong submission", (ids) => [receipt({ ...ids, submissionId: "sub_other" }, "BuildReceipt")], 422, "wrong_submission"],
      ["creator acceptance", (ids) => [receipt(ids, "CreatorAcceptance")], 422, "bad_receipt_type"],
    ];
    it.each(cases)("%s", async (_name, make, status, code) => {
      const t = setup();
      const ids = await withSubmission(t);
      const r = await t.req("POST", `/submissions/${ids.submissionId}/receipts`, { receipts: make(ids) });
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe(code);
      expect((await t.req("GET", `/submissions/${ids.submissionId}/receipts`)).body.receipts).toHaveLength(0);
    });

    it("reused receipt", async () => {
      const t = setup();
      const a = await withSubmission(t);
      const build = receipt(a, "BuildReceipt");
      expect((await t.req("POST", `/submissions/${a.submissionId}/receipts`, { receipts: [build] })).status).toBe(201);
      const test = receipt(a, "TestReceipt", true, { signature: build.signature });
      const r = await t.req("POST", `/submissions/${a.submissionId}/receipts`, { receipts: [test] });
      expect(r.body.error.code).toBe("replayed_receipt");
    });

    it("rolls back the whole batch on one bad receipt", async () => {
      const t = setup();
      const ids = await withSubmission(t);
      const r = await t.req("POST", `/submissions/${ids.submissionId}/receipts`, {
        receipts: [receipt(ids, "BuildReceipt"), receipt(ids, "TestReceipt", true, { commitHash: "c".repeat(40) })],
      });
      expect(r.status).toBe(422);
      const sub = (await t.req("GET", `/submissions/${ids.submissionId}`)).body.submission;
      expect(sub.state).toBe("CODE_SUBMITTED");
    });
  });
});

describe("events", () => {
  it("streams filtered SSE events", async () => {
    const t = setup();
    const a = await t.req("POST", "/bounties", bountyBody);
    const b = await t.req("POST", "/bounties", bountyBody);
    const ctrl = new AbortController();
    const res = await t.app.request(`/events?bountyId=${a.body.bounty.id}`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += dec.decode((await reader.read()).value);
    };
    await readUntil("event: ready");
    await t.req("POST", `/bounties/${b.body.bounty.id}/submissions`, { agentId: "x", commitHash: COMMIT, repoUrl: "https://g.com/r" });
    await t.req("POST", `/bounties/${a.body.bounty.id}/submissions`, { agentId: "y", commitHash: COMMIT, repoUrl: "https://g.com/r" });
    await readUntil("submission.created");
    expect(text).toContain('"agentId":"y"');
    expect(text).not.toContain('"agentId":"x"');
    ctrl.abort();
    await reader.cancel();
  });

  it("rejects a malformed bountyId filter", async () => {
    const t = setup();
    expect((await t.req("GET", "/events?bountyId=..%2F")).status).toBe(400);
  });
});
