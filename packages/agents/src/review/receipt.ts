import {
  commitHashToBytes32,
  RECEIPT_TYPE,
  receiptDomain,
  receiptTypes,
  type Hex,
  type ReceiptMessage,
  type SignedReceipt as ApiSignedReceipt,
} from "@abm/shared";
import { recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const REVIEWER_KEY_ENV = "REVIEWER_SIGNER_PRIVATE_KEY";
export const REVIEWER_VERSION = "abm-reviewer-0.1.0";
export const DEFAULT_REVIEW_TTL_SEC = 24 * 60 * 60;

export interface SigningContext {
  chainId: number;
  verifyingContract: Hex;
}

export interface SecurityReceiptInput {
  /** Ids the API knows (bty_…, sub_…). They go in the receipt posted to the API. */
  apiBountyId: string;
  apiSubmissionId: string;
  /** Onchain uint256 ids, as decimal strings. They go in the signed EIP-712 struct. */
  onchainBountyId: string;
  onchainSubmissionId: string;
  commitHash: string;
  pass: boolean;
  runnerVersion?: string;
  ttlSec?: number;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
}

export interface SignedSecurityReceipt {
  /** Exact struct that was signed; pass it to `BountyEscrow.submitReceipt`. */
  message: ReceiptMessage;
  /** Same receipt in the API's `POST /submissions/:id/receipts` shape. */
  apiReceipt: ApiSignedReceipt;
  signature: Hex;
  signer: Address;
}

/** Loads the reviewer key from env. Keep it in the reviewer process only. */
export function loadReviewerFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount {
  const key = env[REVIEWER_KEY_ENV];
  if (!key) throw new Error(`${REVIEWER_KEY_ENV} is not set`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${REVIEWER_KEY_ENV} must be a 0x-prefixed 32-byte hex key`);
  return privateKeyToAccount(key as Hex);
}

const uint = (v: string, field: string): bigint => {
  if (!/^[0-9]{1,78}$/.test(v)) throw new Error(`${field} must be an onchain uint256 id, got ${v}`);
  return BigInt(v);
};

function typedData(message: ReceiptMessage, ctx: SigningContext) {
  return {
    domain: receiptDomain(ctx.chainId, ctx.verifyingContract),
    types: receiptTypes,
    primaryType: "SecurityReviewReceipt" as const,
    message,
  };
}

/** Signs a SecurityReviewReceipt (EIP-712, schema from @abm/shared) bound to one commit. */
export async function signSecurityReview(
  input: SecurityReceiptInput,
  ctx: SigningContext,
  account: PrivateKeyAccount = loadReviewerFromEnv(),
): Promise<SignedSecurityReceipt> {
  const commitHash = input.commitHash.toLowerCase().replace(/^0x/, "");
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const expiry = timestamp + (input.ttlSec ?? DEFAULT_REVIEW_TTL_SEC);
  const runnerVersion = input.runnerVersion ?? REVIEWER_VERSION;
  const message: ReceiptMessage = {
    bountyId: uint(input.onchainBountyId, "onchainBountyId"),
    submissionId: uint(input.onchainSubmissionId, "onchainSubmissionId"),
    commitHash: commitHashToBytes32(commitHash),
    receiptType: RECEIPT_TYPE.SecurityReview,
    runnerVersion,
    result: input.pass,
    timestamp: BigInt(timestamp),
    expiry: BigInt(expiry),
  };
  const signature = await account.signTypedData(typedData(message, ctx));
  return {
    message,
    signature,
    signer: account.address,
    apiReceipt: {
      bountyId: input.apiBountyId,
      submissionId: input.apiSubmissionId,
      commitHash,
      receiptType: "SecurityReviewReceipt",
      runnerVersion,
      result: input.pass,
      timestamp,
      expiry,
      signature,
      signer: account.address,
    },
  };
}

export function recoverSecurityReviewSigner(
  signed: Pick<SignedSecurityReceipt, "message" | "signature">,
  ctx: SigningContext,
): Promise<Address> {
  return recoverTypedDataAddress({ ...typedData(signed.message, ctx), signature: signed.signature });
}
