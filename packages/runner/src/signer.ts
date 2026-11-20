import type { Hex, Receipt } from "@abm/shared";
import { recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { receiptDomain, receiptTypes, type SignableReceiptType } from "./eip712.js";

export interface SignedReceipt {
  receipt: Receipt;
  signature: Hex;
  signer: Address;
}

export interface SigningContext {
  chainId: number;
  verifyingContract: Hex;
}

export const SIGNER_ENV_VAR = "RUNNER_SIGNER_PRIVATE_KEY";

/**
 * Loads the runner's signing key from the runner process env. The key stays in
 * this process; nothing in the sandbox path reads `process.env`.
 */
export function loadSignerFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount {
  const key = env[SIGNER_ENV_VAR];
  if (!key) throw new Error(`${SIGNER_ENV_VAR} is not set`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${SIGNER_ENV_VAR} must be a 0x-prefixed 32-byte hex key`);
  }
  return privateKeyToAccount(key as Hex);
}

function assertSignable(t: Receipt["receiptType"]): SignableReceiptType {
  if (t in receiptTypes) return t as SignableReceiptType;
  throw new Error(`runner cannot sign receipt type ${t}`);
}

function message(receipt: Receipt) {
  return {
    bountyId: receipt.bountyId,
    submissionId: receipt.submissionId,
    commitHash: receipt.commitHash,
    receiptType: receipt.receiptType,
    runnerVersion: receipt.runnerVersion,
    result: receipt.result,
    timestamp: BigInt(receipt.timestamp),
    expiry: BigInt(receipt.expiry),
  };
}

export async function signReceipt(
  account: PrivateKeyAccount,
  receipt: Receipt,
  ctx: SigningContext,
): Promise<SignedReceipt> {
  const primaryType = assertSignable(receipt.receiptType);
  const signature = await account.signTypedData({
    domain: receiptDomain(ctx.chainId, ctx.verifyingContract),
    types: receiptTypes,
    primaryType,
    message: message(receipt),
  });
  return { receipt, signature, signer: account.address };
}

export async function recoverReceiptSigner(signed: Omit<SignedReceipt, "signer">, ctx: SigningContext): Promise<Address> {
  const primaryType = assertSignable(signed.receipt.receiptType);
  return recoverTypedDataAddress({
    domain: receiptDomain(ctx.chainId, ctx.verifyingContract),
    types: receiptTypes,
    primaryType,
    message: message(signed.receipt),
    signature: signed.signature,
  });
}
