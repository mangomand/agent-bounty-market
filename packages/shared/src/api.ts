/**
 * Request/response types and validation schemas for the local API (`apps/api`).
 * Shared by the API, MCP server, CLI, web page, and runner. See apps/api/README.md.
 */
import { z } from "zod";
import type { Bounty, Hex, Receipt, ReceiptType, Submission, WorkflowState } from "./index";

// ---------- primitives ----------

export const idSchema = (prefix: "bty" | "sub" | "rcpt" | "run") =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{1,32}$`), `expected a ${prefix}_… id`);

export const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex") as z.ZodType<Hex>;
export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte hex") as z.ZodType<Hex>;
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an address") as z.ZodType<Hex>;
export const txHashSchema = bytes32Schema;
/** Git commit id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
export const commitHashSchema = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "expected a lowercase git commit hash");
/** Human-readable USDC amount, up to 6 decimals, e.g. "250" or "12.5". */
export const usdcAmountSchema = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, "expected a decimal USDC amount");
export const httpsUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((u) => u.startsWith("https://"), "only https:// URLs are allowed");

/** Max decoded size of a submitted source tarball. */
export const MAX_TARBALL_BYTES = 10 * 1024 * 1024;

// ---------- bounties ----------

export const createBountySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(""),
  /** Locked spec text shown to agents. Its hash should equal specHash. */
  spec: z.string().max(100_000).default(""),
  specHash: bytes32Schema,
  testSuiteHash: bytes32Schema,
  amountUsdc: usdcAmountSchema,
  /** Unix seconds. */
  deadline: z.number().int().positive(),
  creator: addressSchema,
  /** Base repository agents start from. */
  repoUrl: httpsUrlSchema.optional(),
  repoRef: z.string().max(200).optional(),
  /** Fixed test command from the locked spec. */
  testCommand: z.string().min(1).max(500).default("npm test"),
  allowNetwork: z.boolean().default(false),
  /** Bounty id in the contract, if already created onchain. */
  onchainId: z.string().regex(/^\d{1,78}$/).optional(),
  fundTxHash: txHashSchema.optional(),
});
export type CreateBountyRequest = z.input<typeof createBountySchema>;

export interface ApiBounty extends Bounty {
  description: string;
  spec: string;
  repoUrl: string | null;
  repoRef: string | null;
  testCommand: string;
  allowNetwork: boolean;
  onchainId: string | null;
  fundTxHash: Hex | null;
  /** Set once a submission is accepted. */
  acceptedSubmissionId: string | null;
  payoutTxHash: Hex | null;
  createdAt: number;
  submissionCount: number;
}

export interface RepositoryInfo {
  bountyId: string;
  repoUrl: string | null;
  repoRef: string | null;
  testCommand: string;
  allowNetwork: boolean;
}

// ---------- submissions ----------

export const createSubmissionSchema = z
  .object({
    agentId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "agentId: 1-64 chars of [A-Za-z0-9._-]"),
    commitHash: commitHashSchema,
    /** Address that receives the USDC payout if this submission is accepted. Locked onchain at submit time. */
    payoutAddress: addressSchema,
    /** Either a public https git URL containing commitHash ... */
    repoUrl: httpsUrlSchema.optional(),
    /** ... or a base64 .tar.gz of the source tree (max 10 MB decoded). */
    sourceTarballBase64: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64")
      .max(Math.ceil(MAX_TARBALL_BYTES / 3) * 4)
      .optional(),
  })
  .refine((s) => (s.repoUrl ? 1 : 0) + (s.sourceTarballBase64 ? 1 : 0) === 1, {
    message: "provide exactly one of repoUrl or sourceTarballBase64",
  });
export type CreateSubmissionRequest = z.input<typeof createSubmissionSchema>;

export type CheckStatus = "pending" | "running" | "passed" | "failed" | "error";

export interface SubmissionChecks {
  build: CheckStatus;
  test: CheckStatus;
  security: CheckStatus;
}

export interface ApiSubmission extends Submission {
  source: { kind: "git"; repoUrl: string } | { kind: "tarball"; bytes: number };
  checks: SubmissionChecks;
  payoutAddress: Hex;
  /** Submission id in the contract, once registered onchain. */
  onchainId: string | null;
  /** Tx that registered the submission onchain (`submitCode`). */
  submitTxHash: Hex | null;
  acceptTxHash: Hex | null;
  updatedAt: number;
}

// ---------- receipts ----------

export const RECEIPT_TYPES = ["BuildReceipt", "TestReceipt", "SecurityReviewReceipt", "CreatorAcceptance"] as const;

export const signedReceiptSchema = z.object({
  bountyId: z.string().min(1).max(78),
  submissionId: z.string().min(1).max(78),
  commitHash: commitHashSchema,
  receiptType: z.enum(RECEIPT_TYPES),
  runnerVersion: z.string().min(1).max(100),
  result: z.boolean(),
  timestamp: z.number().int().nonnegative(),
  expiry: z.number().int().nonnegative(),
  /** EIP-712 signature by the runner key. */
  signature: hexSchema,
  signer: addressSchema,
  /** Optional hash of the run logs (logs stay offchain). */
  logsHash: bytes32Schema.optional(),
});
export type SignedReceipt = z.infer<typeof signedReceiptSchema>;

export const postReceiptsSchema = z.object({ receipts: z.array(signedReceiptSchema).min(1).max(10) });
export type PostReceiptsRequest = z.infer<typeof postReceiptsSchema>;

export interface ApiReceipt extends Receipt {
  id: string;
  signature: Hex;
  signer: Hex;
  logsHash: Hex | null;
  /** EIP-712 digest the contract stores (set when a chain is configured). */
  digest: Hex | null;
  /** Tx that relayed the receipt to the contract, if it was relayed. */
  txHash: Hex | null;
  receivedAt: number;
}

// ---------- runs ----------

export type RunKind = "test" | "security";
export const requestRunSchema = z.object({ kind: z.enum(["test", "security"]) });
export type RequestRunRequest = z.infer<typeof requestRunSchema>;

export interface ApiRun {
  id: string;
  submissionId: string;
  kind: RunKind;
  status: "running" | "finished" | "error";
  error: string | null;
  /** Tail of the build/test/review output (failing output first). Never stored onchain. */
  logs: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** Job handed to the sandbox runner. `test` produces Build + Test receipts; `security` a SecurityReview receipt. */
export interface RunJob {
  runId: string;
  kind: RunKind;
  bounty: ApiBounty;
  submission: ApiSubmission;
  source: { kind: "git"; repoUrl: string; commitHash: string } | { kind: "tarball"; base64: string };
}

export interface RunResult {
  receipts: SignedReceipt[];
  /** Tail of the run output, shown to agents so they can fix failures. */
  logs?: string;
}

/** Implemented by @abm/runner (in-process) or an HTTP adapter. The API never signs receipts itself. */
export interface RunnerClient {
  run(job: RunJob): Promise<RunResult>;
}

// ---------- funding ----------

export const fundBountySchema = z.object({
  /** Hash of the creator's `createBounty` transaction. The API reads the BountyCreated event from it. */
  txHash: txHashSchema,
});
export type FundBountyRequest = z.infer<typeof fundBountySchema>;

// ---------- accept ----------

export const acceptSubmissionSchema = z.object({
  /** Address of the creator accepting; must match the bounty creator. */
  creator: addressSchema,
  /** Hash of the onchain accept/payout transaction the creator's wallet sent. */
  txHash: txHashSchema,
});
export type AcceptSubmissionRequest = z.infer<typeof acceptSubmissionSchema>;

// ---------- events (SSE) ----------

export type ApiEvent =
  | { type: "bounty.created"; bountyId: string; bounty: ApiBounty }
  | { type: "bounty.updated"; bountyId: string; bounty: ApiBounty }
  | { type: "submission.created"; bountyId: string; submission: ApiSubmission }
  | { type: "submission.updated"; bountyId: string; submission: ApiSubmission }
  | { type: "receipt.created"; bountyId: string; receipt: ApiReceipt }
  | { type: "run.started"; bountyId: string; run: ApiRun }
  | { type: "run.finished"; bountyId: string; run: ApiRun };

export type ApiEventType = ApiEvent["type"];

// ---------- errors ----------

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// Re-exported for convenience.
export type { ReceiptType, WorkflowState };
