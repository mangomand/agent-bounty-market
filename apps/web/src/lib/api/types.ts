import type { Bounty, Hex, Submission, WorkflowState } from "@abm/shared";

/** Bounty as returned by the API: the shared onchain shape plus the locked spec. */
export interface BountyView extends Bounty {
  spec: string;
  testCommand: string;
  submissionCount: number;
  /** Set once the escrow has been funded onchain. */
  fundTx?: Hex;
  /** Bounty id in the contract; null until funded. */
  onchainId?: string | null;
  /** The contract would accept `refund` from the creator now (funded, open, past the deadline). */
  canRefund?: boolean;
  /** Set once the creator refunded the escrow. */
  refundTx?: Hex;
}

/** Submission as returned by the API, with failure and payout details. */
export interface SubmissionView extends Submission {
  /** Present when a receipt came back failed; `state` is the step that failed. */
  failure?: { state: WorkflowState; reason: string };
  payoutTx?: Hex;
  /** Submission id in the contract. The creator's accept tx uses this. */
  onchainId?: string | null;
  payoutAddress?: Hex;
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
  /** Wallet that sent the accept tx; must be the bounty creator. */
  creator: Hex;
  /** Transaction that recorded CREATOR_ACCEPTED and released the payout. */
  txHash: Hex;
}

export interface RefundInput {
  /** Wallet that sent the refund tx; must be the bounty creator. */
  creator: Hex;
  txHash: Hex;
}

export interface ApiClient {
  listBounties(): Promise<BountyView[]>;
  getBounty(id: string): Promise<BountyView>;
  listSubmissions(bountyId: string): Promise<SubmissionView[]>;
  createBounty(input: CreateBountyInput): Promise<BountyView>;
  /** Links a posted bounty to the creator's onchain `createBounty` tx. The API verifies it. */
  recordFunding(bountyId: string, txHash: Hex): Promise<BountyView>;
  acceptSubmission(submissionId: string, input: AcceptInput): Promise<SubmissionView>;
  /** Records the creator's onchain `refund` tx. The API verifies it. */
  recordRefund(bountyId: string, input: RefundInput): Promise<BountyView>;
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
