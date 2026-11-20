import type { Hex } from "@abm/shared";

// TODO: delete this file and import `receiptTypes` / `receiptDomain` from
// `@abm/shared` once the contract PR adding `packages/shared/src/eip712.ts`
// lands. The export names match that file; field types must match the contract.

const receiptFields = [
  { name: "bountyId", type: "string" },
  { name: "submissionId", type: "string" },
  { name: "commitHash", type: "string" },
  { name: "receiptType", type: "string" },
  { name: "runnerVersion", type: "string" },
  { name: "result", type: "bool" },
  { name: "timestamp", type: "uint64" },
  { name: "expiry", type: "uint64" },
] as const;

export const receiptTypes = {
  BuildReceipt: receiptFields,
  TestReceipt: receiptFields,
  SecurityReviewReceipt: receiptFields,
} as const;

export type SignableReceiptType = keyof typeof receiptTypes;

export const RECEIPT_DOMAIN_NAME = "AgentBountyMarket";
export const RECEIPT_DOMAIN_VERSION = "1";

export function receiptDomain(chainId: number, verifyingContract: Hex) {
  return {
    name: RECEIPT_DOMAIN_NAME,
    version: RECEIPT_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}
