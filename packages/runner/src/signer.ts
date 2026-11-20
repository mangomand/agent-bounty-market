import {
  receiptDomain,
  receiptPrimaryType,
  receiptTypes,
  type Hex,
  type Receipt,
  type ReceiptMessage,
  toReceiptMessage,
} from "@abm/shared";
import { recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface SignedReceipt {
  /** Off-chain view with string ids, as in `@abm/shared`. */
  receipt: Receipt;
  /** Exact struct that was signed; pass it to `BountyEscrow.submitReceipt`. */
  message: ReceiptMessage;
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

/** Converts the off-chain receipt into the struct `BountyEscrow` verifies. */
export { toReceiptMessage };

function typedData(message: ReceiptMessage, ctx: SigningContext) {
  return {
    domain: receiptDomain(ctx.chainId, ctx.verifyingContract),
    types: receiptTypes,
    primaryType: receiptPrimaryType(message.receiptType),
    message,
  };
}

export async function signReceipt(
  account: PrivateKeyAccount,
  receipt: Receipt,
  ctx: SigningContext,
): Promise<SignedReceipt> {
  const message = toReceiptMessage(receipt);
  const signature = await account.signTypedData(typedData(message, ctx));
  return { receipt, message, signature, signer: account.address };
}

export async function recoverReceiptSigner(
  signed: Pick<SignedReceipt, "message" | "signature">,
  ctx: SigningContext,
): Promise<Address> {
  return recoverTypedDataAddress({ ...typedData(signed.message, ctx), signature: signed.signature });
}
