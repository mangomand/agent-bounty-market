import type { Hex } from "@abm/shared";

// NEXT_PUBLIC_* values must be referenced literally so Next.js inlines them.
export const config = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8545",
  mock: process.env.NEXT_PUBLIC_MOCK === "1",
  bountyContract: (process.env.NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS || undefined) as Hex | undefined,
  usdc: (process.env.NEXT_PUBLIC_USDC_ADDRESS || undefined) as Hex | undefined,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || undefined,
};

/** Explorer link for a transaction, or null when no explorer is configured (local Anvil). */
export function txUrl(hash: Hex, explorerUrl = config.explorerUrl): string | null {
  if (!explorerUrl) return null;
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
}
