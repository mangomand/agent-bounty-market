import type { Hex } from "./index";

/**
 * EIP-712 schema for evidence receipts verified by BountyEscrow.sol.
 * Field order and types must match `Receipt` in contracts/src/BountyEscrow.sol.
 *
 * Signing with viem:
 *   account.signTypedData({
 *     domain: receiptDomain(chainId, escrowAddress),
 *     types: receiptTypes,
 *     primaryType: receiptPrimaryType(RECEIPT_TYPE.Build),
 *     message,
 *   })
 */

export const RECEIPT_DOMAIN_NAME = "AgentBountyMarket";
export const RECEIPT_DOMAIN_VERSION = "1";

export function receiptDomain(chainId: number | bigint, verifyingContract: Hex) {
  return {
    name: RECEIPT_DOMAIN_NAME,
    version: RECEIPT_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract,
  } as const;
}

const receiptFields = [
  { name: "bountyId", type: "uint256" },
  { name: "submissionId", type: "uint256" },
  { name: "commitHash", type: "bytes32" },
  { name: "receiptType", type: "uint8" },
  { name: "runnerVersion", type: "string" },
  { name: "result", type: "bool" },
  { name: "timestamp", type: "uint64" },
  { name: "expiry", type: "uint64" },
] as const;

/** All three receipt kinds share one field list; the primary type name differs. */
export const receiptTypes = {
  BuildReceipt: receiptFields,
  TestReceipt: receiptFields,
  SecurityReviewReceipt: receiptFields,
} as const;

export type ReceiptPrimaryType = keyof typeof receiptTypes;

/** Numeric `receiptType` values, matching `BountyEscrow.ReceiptType`. */
export const RECEIPT_TYPE = {
  Build: 0,
  Test: 1,
  SecurityReview: 2,
} as const;

export type ReceiptTypeId = (typeof RECEIPT_TYPE)[keyof typeof RECEIPT_TYPE];

const PRIMARY_TYPES: readonly ReceiptPrimaryType[] = ["BuildReceipt", "TestReceipt", "SecurityReviewReceipt"];

export function receiptPrimaryType(receiptType: ReceiptTypeId): ReceiptPrimaryType {
  const t = PRIMARY_TYPES[receiptType];
  if (!t) throw new Error(`unknown receiptType ${String(receiptType)}`);
  return t;
}

/** Message shape for signTypedData and for the `submitReceipt` call tuple. */
export interface ReceiptMessage {
  bountyId: bigint;
  submissionId: bigint;
  commitHash: Hex;
  receiptType: ReceiptTypeId;
  runnerVersion: string;
  result: boolean;
  timestamp: bigint;
  expiry: bigint;
}

/**
 * Canonical EIP-712 encodeType string for a receipt kind. The contract's typehash is
 * keccak256 of this string.
 */
export function receiptTypeString(primaryType: ReceiptPrimaryType): string {
  const fields = receiptTypes[primaryType].map((f) => `${f.type} ${f.name}`).join(",");
  return `${primaryType}(${fields})`;
}

/**
 * Converts a git commit id (40-hex SHA-1 or 64-hex SHA-256, with or without 0x) to the
 * bytes32 `commitHash` used onchain. SHA-1 ids are left-padded with zeros.
 */
export function commitHashToBytes32(commit: string): Hex {
  const hex = commit.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`invalid commit id: ${commit}`);
  }
  return `0x${hex.padStart(64, "0")}`;
}
