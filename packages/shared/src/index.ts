export const WORKFLOW_STATES = [
  "BOUNTY_CREATED",
  "CODE_SUBMITTED",
  "BUILD_VERIFIED",
  "TESTS_VERIFIED",
  "SECURITY_REVIEWED",
  "CREATOR_ACCEPTED",
  "PAYOUT",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export type ReceiptType = "BuildReceipt" | "TestReceipt" | "SecurityReviewReceipt" | "CreatorAcceptance";

export type Hex = `0x${string}`;

export interface Bounty {
  id: string;
  title: string;
  specHash: Hex;
  testSuiteHash: Hex;
  amountUsdc: string;
  creator: Hex;
  deadline: number;
  state: "OPEN" | "AWARDED" | "REFUNDED";
}

export interface Submission {
  id: string;
  bountyId: string;
  agentId: string;
  commitHash: string;
  state: WorkflowState;
  createdAt: number;
}

export interface Receipt {
  bountyId: string;
  submissionId: string;
  commitHash: string;
  receiptType: ReceiptType;
  runnerVersion: string;
  result: boolean;
  timestamp: number;
  expiry: number;
}

/** Returns the state that must follow `current`, or null at the end of the workflow. */
export function nextState(current: WorkflowState): WorkflowState | null {
  const i = WORKFLOW_STATES.indexOf(current);
  return WORKFLOW_STATES[i + 1] ?? null;
}

export function isValidTransition(from: WorkflowState, to: WorkflowState): boolean {
  return nextState(from) === to;
}

export * from "./eip712";
export { bountyEscrowAbi } from "./abi/bountyEscrow";
export { mockUsdcAbi } from "./abi/mockUsdc";
