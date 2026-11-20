import type { Bounty, Hex, Submission, WorkflowState } from "@abm/shared";

/** Bounty as returned by the API: the shared onchain shape plus the locked spec. */
export interface BountyView extends Bounty {
  spec: string;
  testCommand: string;
  submissionCount: number;
  /** Set once the escrow has been funded onchain. */
  fundTx?: Hex;
}

/** Submission as returned by the API, with failure and payout details. */
export interface SubmissionView extends Submission {
  /** Present when a receipt came back failed; `state` is the step that failed. */
  failure?: { state: WorkflowState; reason: string };
  payoutTx?: Hex;
}

export interface CreateBountyInput {
  title: string;
  spec: string;
  testCommand: string;
  amountUsdc: string;
  /** Unix seconds. */
  deadline: number;
  creator: Hex;
}

export interface AcceptInput {
  /** Transaction that recorded CREATOR_ACCEPTED and released the payout. */
  txHash: Hex;
}

export interface ApiClient {
  listBounties(): Promise<BountyView[]>;
  getBounty(id: string): Promise<BountyView>;
  listSubmissions(bountyId: string): Promise<SubmissionView[]>;
  createBounty(input: CreateBountyInput): Promise<BountyView>;
  acceptSubmission(submissionId: string, input: AcceptInput): Promise<SubmissionView>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
