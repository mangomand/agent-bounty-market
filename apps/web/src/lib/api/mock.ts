import { WORKFLOW_STATES, type Hex, type WorkflowState } from "@abm/shared";
import { ApiError, type ApiClient, type BountyView, type SubmissionView } from "./types";

const DAY = 86_400;
const STEP_MS = 4_000;

function fakeHash(seed: string): Hex {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    for (const ch of `${seed}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return `0x${out.slice(0, 64)}`;
}

type MockSubmission = SubmissionView & {
  /** Advances one workflow step every STEP_MS from `startedAt` until it reaches `target`. */
  live?: { startedAt: number; target: WorkflowState };
};

export function createMockClient(now: () => number = Date.now): ApiClient {
  const t = Math.floor(now() / 1000);
  const creator: Hex = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  const bounties: BountyView[] = [
    {
      id: "1",
      title: "Rate limiter middleware for Express",
      spec: "Token-bucket rate limiter as Express middleware.\n\n- Per-IP buckets, configurable `capacity` and `refillPerSecond`\n- Responds `429` with `Retry-After`\n- No external stores",
      testCommand: "pnpm test",
      specHash: fakeHash("spec-1"),
      testSuiteHash: fakeHash("tests-1"),
      amountUsdc: "250",
      creator,
      deadline: t + 5 * DAY,
      state: "OPEN",
      submissionCount: 3,
      fundTx: fakeHash("fund-1"),
    },
    {
      id: "2",
      title: "CSV to JSON streaming parser",
      spec: "Stream CSV from stdin to newline-delimited JSON on stdout. Handle quoted fields and CRLF.",
      testCommand: "npm test",
      specHash: fakeHash("spec-2"),
      testSuiteHash: fakeHash("tests-2"),
      amountUsdc: "120",
      creator,
      deadline: t + 2 * DAY,
      state: "OPEN",
      submissionCount: 1,
      fundTx: fakeHash("fund-2"),
    },
    {
      id: "3",
      title: "Fix timezone bug in cron parser",
      spec: "`nextRun()` returns the wrong hour across DST transitions. Fix it and add tests.",
      testCommand: "pnpm vitest run",
      specHash: fakeHash("spec-3"),
      testSuiteHash: fakeHash("tests-3"),
      amountUsdc: "80",
      creator,
      deadline: t - DAY,
      state: "AWARDED",
      submissionCount: 1,
      fundTx: fakeHash("fund-3"),
    },
  ];

  const submissions: MockSubmission[] = [
    {
      id: "s-101",
      bountyId: "1",
      agentId: "security-agent",
      commitHash: "9f2c4e1a7b3d5c8e0f1a2b3c4d5e6f7a8b9c0d1e",
      state: "SECURITY_REVIEWED",
      createdAt: t - 3_600,
    },
    {
      id: "s-102",
      bountyId: "1",
      agentId: "fast-agent",
      commitHash: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      state: "BUILD_VERIFIED",
      failure: { state: "TESTS_VERIFIED", reason: "3 of 14 tests failed" },
      createdAt: t - 2_400,
    },
    {
      id: "s-103",
      bountyId: "1",
      agentId: "test-agent",
      commitHash: "c0ffee00d15ea5e0b16b00b5facefeed0badf00d",
      state: "CODE_SUBMITTED",
      createdAt: t - 60,
      live: { startedAt: now(), target: "SECURITY_REVIEWED" },
    },
    {
      id: "s-201",
      bountyId: "2",
      agentId: "fast-agent",
      commitHash: "abcdef0123456789abcdef0123456789abcdef01",
      state: "TESTS_VERIFIED",
      createdAt: t - 600,
      live: { startedAt: now(), target: "SECURITY_REVIEWED" },
    },
    {
      id: "s-301",
      bountyId: "3",
      agentId: "test-agent",
      commitHash: "0123456789abcdef0123456789abcdef01234567",
      state: "PAYOUT",
      createdAt: t - 2 * DAY,
      payoutTx: fakeHash("payout-301"),
    },
  ];

  const delay = <T>(value: T, ms = 150) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

  function advance(sub: MockSubmission): SubmissionView {
    if (sub.live) {
      const from = WORKFLOW_STATES.indexOf(sub.state);
      const to = WORKFLOW_STATES.indexOf(sub.live.target);
      const steps = Math.floor((now() - sub.live.startedAt) / STEP_MS);
      const next = Math.min(from + steps, to);
      if (next > from) {
        sub.state = WORKFLOW_STATES[next] ?? sub.state;
        sub.live.startedAt += (next - from) * STEP_MS;
      }
      if (sub.state === sub.live.target) delete sub.live;
    }
    const { live: _live, ...view } = sub;
    return view;
  }

  function findBounty(id: string): BountyView {
    const bounty = bounties.find((b) => b.id === id);
    if (!bounty) throw new ApiError("Bounty not found", 404);
    return bounty;
  }

  return {
    listBounties: () => delay([...bounties].reverse()),
    getBounty: async (id) => delay(findBounty(id)),
    listSubmissions: async (bountyId) => {
      findBounty(bountyId);
      return delay(submissions.filter((s) => s.bountyId === bountyId).map(advance));
    },
    createBounty: async (input) => {
      const id = String(Math.max(...bounties.map((b) => Number(b.id))) + 1);
      const bounty: BountyView = {
        id,
        title: input.title,
        spec: input.spec,
        testCommand: input.testCommand,
        amountUsdc: input.amountUsdc,
        deadline: input.deadline,
        creator: input.creator,
        specHash: fakeHash(`spec-${id}-${input.spec}`),
        testSuiteHash: fakeHash(`tests-${id}-${input.testCommand}`),
        state: "OPEN",
        submissionCount: 0,
      };
      bounties.push(bounty);
      return delay(bounty, 400);
    },
    recordFunding: async (bountyId, txHash) => {
      const bounty = findBounty(bountyId);
      bounty.fundTx = txHash;
      bounty.onchainId = bountyId;
      return delay(bounty, 200);
    },
    acceptSubmission: async (submissionId, input) => {
      const sub = submissions.find((s) => s.id === submissionId);
      if (!sub) throw new ApiError("Submission not found", 404);
      if (sub.state !== "SECURITY_REVIEWED" || sub.failure) {
        throw new ApiError("Submission has not passed every check", 409);
      }
      const bounty = findBounty(sub.bountyId);
      if (bounty.state !== "OPEN") throw new ApiError("Bounty is already settled", 409);
      sub.state = "PAYOUT";
      sub.payoutTx = input.txHash;
      bounty.state = "AWARDED";
      return delay(advance(sub), 400);
    },
    recordRefund: async (bountyId, input) => {
      const bounty = findBounty(bountyId);
      if (bounty.state !== "OPEN") throw new ApiError("Bounty is already settled", 409);
      if (bounty.deadline * 1000 >= now()) throw new ApiError("A bounty can only be refunded after its deadline", 409);
      bounty.state = "REFUNDED";
      bounty.refundTx = input.txHash;
      bounty.canRefund = false;
      return delay(bounty, 400);
    },
  };
}

export { fakeHash };
