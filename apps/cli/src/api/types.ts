import type { Bounty, Hex, Receipt, Submission, WorkflowState } from "@abm/shared";

/**
 * View types the CLI renders. They extend the shared domain types with the
 * extra fields the API is expected to return. Everything beyond the shared
 * types is optional so the CLI degrades gracefully if the API omits a field.
 *
 * Units: `amountUsdc` is USDC base units (6 decimals) as a decimal string.
 * `deadline`, `createdAt`, `timestamp`, `expiry` are unix seconds.
 */
export interface BountyView extends Bounty {
  summary?: string;
  repo?: string;
  testCommand?: string;
  allowNetwork?: boolean;
  submissionCount?: number;
}

/**
 * - running:  the step after `state` is being verified right now
 * - waiting:  verified through SECURITY_REVIEWED, waiting for the creator
 * - rejected: the step after `state` failed; see `reason`
 * - paid:     reached PAYOUT; see `payoutTx`
 * - closed:   bounty was awarded to another submission or refunded
 */
export type SubmissionStatus = "running" | "waiting" | "rejected" | "paid" | "closed";

export interface SubmissionView extends Submission {
  status: SubmissionStatus;
  reason?: string;
  payoutTx?: Hex;
}

export interface ReceiptView extends Receipt {
  /** EIP-712 digest of the receipt struct. */
  digest: Hex;
  signature: Hex;
  signer: Hex;
}

export type BountyEvent =
  | { type: "bounty"; bounty: BountyView }
  | { type: "submission"; submission: SubmissionView }
  | { type: "receipt"; receipt: ReceiptView };

export interface BountyClient {
  /** Short label for the data source, shown in headers ("mock" or the API URL). */
  readonly source: string;
  listBounties(): Promise<BountyView[]>;
  getBounty(id: string): Promise<BountyView>;
  listSubmissions(bountyId: string): Promise<SubmissionView[]>;
  getReceipts(submissionId: string): Promise<ReceiptView[]>;
  /** Stream live events for a bounty. Returns an unsubscribe function. */
  subscribe(bountyId: string, onEvent: (e: BountyEvent) => void, onError?: (err: Error) => void): () => void;
  /**
   * Register a submission made by a local demo agent. Real agents submit via
   * the MCP `submit_code` tool; this exists so `bounty run` works end to end.
   */
  submit(input: { bountyId: string; agentId: string; commitHash: string }): Promise<SubmissionView>;
}

export class NotFoundError extends Error {}

export type { Bounty, Hex, Receipt, Submission, WorkflowState };
