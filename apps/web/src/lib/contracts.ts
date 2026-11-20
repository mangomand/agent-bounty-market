/**
 * Contract calls made from the creator page. The page never holds funds or keys:
 * every call here is signed by the creator's wallet.
 *
 * TODO(contracts): the real ABI lands in `@abm/shared` from the contracts PR.
 * Replace BOUNTY_ABI below with that export and match the function names/args.
 */
import type { Hex } from "@abm/shared";
import { erc20Abi, keccak256, parseAbi, parseUnits, toHex } from "viem";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { fakeHash } from "./api/mock";
import { config } from "./config";
import { wagmiConfig } from "./wagmi";

// TODO(contracts): placeholder signatures; swap for the ABI exported by @abm/shared.
const BOUNTY_ABI = parseAbi([
  "function createBounty(bytes32 specHash, bytes32 testSuiteHash, uint256 amount, uint64 deadline) returns (uint256)",
  "function acceptSubmission(uint256 bountyId, bytes32 submissionId)",
]);

const USDC_DECIMALS = 6;

export interface FundBountyArgs {
  specHash: Hex;
  testSuiteHash: Hex;
  amountUsdc: string;
  /** Unix seconds. */
  deadline: number;
}

export interface AcceptArgs {
  /** Onchain bounty id. */
  bountyId: string;
  submissionId: string;
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

/** Approves USDC and escrows it in the bounty contract. Returns the funding tx hash. */
export async function fundBounty(args: FundBountyArgs): Promise<Hex> {
  if (config.mock) return mockTx("fund");
  const { bounty, usdc } = addresses();
  const amount = parseUnits(args.amountUsdc, USDC_DECIMALS);

  const approveTx = await writeContract(wagmiConfig, {
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [bounty, amount],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });

  // TODO(contracts): confirm argument order and whether the API or the contract assigns the id.
  const hash = await writeContract(wagmiConfig, {
    address: bounty,
    abi: BOUNTY_ABI,
    functionName: "createBounty",
    args: [args.specHash, args.testSuiteHash, amount, BigInt(args.deadline)],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}

/** Records CREATOR_ACCEPTED; the contract then releases the payout. Returns the tx hash. */
export async function acceptSubmission(args: AcceptArgs): Promise<Hex> {
  if (config.mock) return mockTx("accept");
  const { bounty } = addresses();
  // TODO(contracts): submission ids are API strings today; the contract likely wants bytes32.
  const hash = await writeContract(wagmiConfig, {
    address: bounty,
    abi: BOUNTY_ABI,
    functionName: "acceptSubmission",
    args: [BigInt(args.bountyId), keccak256(toHex(args.submissionId))],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}
