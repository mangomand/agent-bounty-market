import type { ApiBounty, ApiSubmission, CreateBountyRequest, Hex, WorkflowState } from "@abm/shared";
import { keccak256, toBytes } from "viem";
import { ApiError, type ApiClient, type BountyView, type CreateBountyInput, type SubmissionView } from "./types";

/** Hashes locked onchain with the bounty: the spec text and the fixed test command. */
export function bountyHashes(input: Pick<CreateBountyInput, "spec" | "testCommand">): { specHash: Hex; testSuiteHash: Hex } {
  return { specHash: keccak256(toBytes(input.spec)), testSuiteHash: keccak256(toBytes(`testCommand:${input.testCommand}`)) };
}

export function toBountyView(b: ApiBounty): BountyView {
  return {
    id: b.id,
    title: b.title,
    spec: b.spec,
    testCommand: b.testCommand,
    specHash: b.specHash,
    testSuiteHash: b.testSuiteHash,
    amountUsdc: b.amountUsdc,
    creator: b.creator,
    deadline: b.deadline,
    state: b.state,
    submissionCount: b.submissionCount,
    fundTx: b.fundTxHash ?? undefined,
    onchainId: b.onchainId,
    canRefund: b.canRefund,
    refundTx: b.refundTxHash ?? undefined,
  };
}

const FAILURES: { check: keyof ApiSubmission["checks"]; state: WorkflowState; label: string }[] = [
  { check: "build", state: "BUILD_VERIFIED", label: "Build" },
  { check: "test", state: "TESTS_VERIFIED", label: "Tests" },
  { check: "security", state: "SECURITY_REVIEWED", label: "Security review" },
];

export function toSubmissionView(s: ApiSubmission): SubmissionView {
  let failure: SubmissionView["failure"];
  for (const f of FAILURES) {
    const status = s.checks[f.check];
    if (status === "failed") failure = { state: f.state, reason: `${f.label} failed` };
    else if (status === "error") failure = { state: f.state, reason: `${f.label} could not run` };
    if (failure) break;
  }
  return {
    id: s.id,
    bountyId: s.bountyId,
    agentId: s.agentId,
    commitHash: s.commitHash,
    state: s.state,
    createdAt: s.createdAt,
    failure,
    payoutTx: s.acceptTxHash ?? undefined,
    onchainId: s.onchainId,
    payoutAddress: s.payoutAddress,
  };
}

export function createHttpClient(baseUrl: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
    } catch {
      throw new ApiError(`Can't reach the API at ${root}`, 0);
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`.trim();
      try {
        const body = (await res.json()) as { error?: { message?: unknown } | string };
        if (typeof body.error === "string") message = body.error;
        else if (typeof body.error?.message === "string") message = body.error.message;
      } catch {
        // Non-JSON error body; keep the status line.
      }
      throw new ApiError(message, res.status);
    }
    return (await res.json()) as T;
  }

  const id = (value: string) => encodeURIComponent(value);
  const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

  return {
    listBounties: async () => (await request<{ bounties: ApiBounty[] }>("/bounties")).bounties.map(toBountyView),
    getBounty: async (bountyId) => toBountyView((await request<{ bounty: ApiBounty }>(`/bounties/${id(bountyId)}`)).bounty),
    listSubmissions: async (bountyId) =>
      (await request<{ submissions: ApiSubmission[] }>(`/bounties/${id(bountyId)}/submissions`)).submissions.map(toSubmissionView),
    createBounty: async (input) => {
      const body: CreateBountyRequest = { ...input, ...bountyHashes(input) };
      return toBountyView((await request<{ bounty: ApiBounty }>("/bounties", post(body))).bounty);
    },
    recordFunding: async (bountyId, txHash) =>
      toBountyView((await request<{ bounty: ApiBounty }>(`/bounties/${id(bountyId)}/fund`, post({ txHash }))).bounty),
    acceptSubmission: async (submissionId, input) =>
      toSubmissionView((await request<{ submission: ApiSubmission }>(`/submissions/${id(submissionId)}/accept`, post(input))).submission),
    recordRefund: async (bountyId, input) =>
      toBountyView((await request<{ bounty: ApiBounty }>(`/bounties/${id(bountyId)}/refund`, post(input))).bounty),
  };
}
