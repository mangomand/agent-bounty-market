/**
 * Contract calls made from the creator page. The page never holds funds or keys:
 * every call here is signed by the creator's wallet.
 */
import type { Hex } from "@abm/shared";
import { bountyEscrowAbi, mockUsdcAbi } from "@abm/shared/abi";
import { parseUnits } from "viem";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { fakeHash } from "./api/mock";
import { config } from "./config";
import { wagmiConfig } from "./wagmi";

const USDC_DECIMALS = 6;

export interface FundBountyArgs {
  specHash: Hex;
  testSuiteHash: Hex;
  amountUsdc: string;
  /** Unix seconds. */
  deadline: number;
}

function addresses(): { bounty: Hex; usdc: Hex } {
  if (!config.bountyContract || !config.usdc) {
    throw new Error(
      "Contract addresses not set. Add NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS and NEXT_PUBLIC_USDC_ADDRESS to .env.local.",
    );
  }
  return { bounty: config.bountyContract, usdc: config.usdc };
}

const mockTx = (label: string) =>
  new Promise<Hex>((resolve) => setTimeout(() => resolve(fakeHash(`${label}:${Date.now()}`)), 700));

async function send(hash: Hex): Promise<Hex> {
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return hash;
}

/** Approves USDC and escrows it with `createBounty`. Returns the funding tx hash. */
export async function fundBounty(args: FundBountyArgs): Promise<Hex> {
  if (config.mock) return mockTx("fund");
  const { bounty, usdc } = addresses();
  const amount = parseUnits(args.amountUsdc, USDC_DECIMALS);

  await send(
    await writeContract(wagmiConfig, { address: usdc, abi: mockUsdcAbi, functionName: "approve", args: [bounty, amount] }),
  );
  return send(
    await writeContract(wagmiConfig, {
      address: bounty,
      abi: bountyEscrowAbi,
      functionName: "createBounty",
      args: [args.specHash, args.testSuiteHash, amount, BigInt(args.deadline)],
    }),
  );
}

/** Returns the escrow to the creator. The contract allows it only after the deadline, with no accepted submission. */
export async function refundBounty(bountyOnchainId: string): Promise<Hex> {
  if (config.mock) return mockTx("refund");
  const { bounty } = addresses();
  return send(
    await writeContract(wagmiConfig, {
      address: bounty,
      abi: bountyEscrowAbi,
      functionName: "refund",
      args: [BigInt(bountyOnchainId)],
    }),
  );
}

/** CREATOR_ACCEPTED → PAYOUT in one tx: the contract pays the submitter. Returns the tx hash. */
export async function acceptSubmission(submissionOnchainId: string): Promise<Hex> {
  if (config.mock) return mockTx("accept");
  const { bounty } = addresses();
  return send(
    await writeContract(wagmiConfig, {
      address: bounty,
      abi: bountyEscrowAbi,
      functionName: "acceptSubmission",
      args: [BigInt(submissionOnchainId)],
    }),
  );
}
