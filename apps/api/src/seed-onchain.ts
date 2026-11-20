/**
 * Funds the demo bounties onchain as the creator, then inserts them into the API database
 * linked to their onchain ids. Local Anvil only: the creator key is Anvil's well-known account #0.
 *
 * Env: RPC_URL, CHAIN_ID, BOUNTY_CONTRACT_ADDRESS, USDC_ADDRESS, CREATOR_PRIVATE_KEY, API_DB_PATH
 */
import { bountyEscrowAbi, mockUsdcAbi } from "@abm/shared/abi";
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { openDb } from "./db";
import { DEMO, demoDeadline, demoHashes, seed, type DemoFunding } from "./seed";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
const chain = defineChain({
  id: Number(process.env.CHAIN_ID ?? 31337),
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(env("CREATOR_PRIVATE_KEY") as Hex);
const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 250 });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
const escrow = env("BOUNTY_CONTRACT_ADDRESS") as Hex;
const usdc = env("USDC_ADDRESS") as Hex;

const db = openDb(config.dbPath);
const already = new Set(db.prepare("SELECT id FROM bounties WHERE onchain_id IS NOT NULL").all().map((r) => String(r.id)));
const nowSec = Number((await pub.getBlock()).timestamp);
const funded: Record<string, DemoFunding> = {};

for (const b of DEMO) {
  if (already.has(b.id)) continue;
  const amount = parseUnits(b.amountUsdc, 6);
  const deadline = demoDeadline(nowSec);
  const { specHash, testSuiteHash } = demoHashes(b);
  const approve = await wallet.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "approve", args: [escrow, amount] });
  await pub.waitForTransactionReceipt({ hash: approve });
  const hash = await wallet.writeContract({
    address: escrow,
    abi: bountyEscrowAbi,
    functionName: "createBounty",
    args: [specHash, testSuiteHash, amount, BigInt(deadline)],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi: bountyEscrowAbi, logs: receipt.logs, eventName: "BountyCreated" });
  if (!ev) throw new Error(`createBounty for ${b.id} emitted no BountyCreated`);
  funded[b.id] = { onchainId: ev.args.bountyId.toString(), fundTxHash: hash, creator: account.address, deadline };
  console.log(`funded ${b.id} as onchain bounty #${ev.args.bountyId} (${b.amountUsdc} USDC, tx ${hash})`);
}

console.log(`seeded ${seed(db, nowSec, funded)} funded demo bounties into ${config.dbPath}`);
db.close();
