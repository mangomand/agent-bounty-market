import {
  WORKFLOW_STATES,
  commitHashToBytes32,
  receiptDomain,
  receiptPrimaryType,
  receiptTypes,
  toReceiptMessage,
  type Hex,
  type SignedReceipt,
  type WorkflowState,
} from "@abm/shared";
import { bountyEscrowAbi } from "@abm/shared/abi";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  parseEventLogs,
  parseUnits,
  type Address,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Everything the API does onchain. The relayer key only pays gas for `submitCode` and
 * `submitReceipt`, which anyone may call; it holds no role and cannot move bounty funds.
 * Payout happens only in `acceptSubmission`, which the contract restricts to the creator.
 */
export interface ChainClient {
  readonly chainId: number;
  readonly contract: Hex;
  /** Reads BountyCreated from the creator's funding tx and checks it matches the bounty. */
  verifyFunding(txHash: Hex, expected: FundingExpectation): Promise<{ onchainId: string }>;
  registerSubmission(bountyOnchainId: string, commitHash: string, payoutAddress: Hex): Promise<{ onchainId: string; txHash: Hex }>;
  relayReceipt(r: SignedReceipt): Promise<{ txHash: Hex }>;
  receiptDigest(r: SignedReceipt): Hex | null;
  submissionState(onchainId: string): Promise<WorkflowState>;
  /** Checks the tx paid out `submissionOnchainId` from this contract. */
  verifyPayout(txHash: Hex, submissionOnchainId: string): Promise<{ to: Hex; amount: bigint; from: Hex }>;
}

export interface FundingExpectation {
  creator: Hex;
  specHash: Hex;
  testSuiteHash: Hex;
  amountUsdc: string;
  deadline: number;
}

export class ChainError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

/** Pulls the custom error name (e.g. `InvalidTransition`) out of a viem revert. */
export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name) return `${name}(${(revert.data?.args ?? []).map(String).join(", ")})`;
      return revert.reason ?? revert.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
  contract: Hex;
  relayerKey: Hex;
}

export function createChainClient(cfg: ChainConfig): ChainClient {
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 31337 ? "Anvil" : `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const transport = http(cfg.rpcUrl);
  const pub = createPublicClient({ chain, transport, pollingInterval: 250 });
  const account = privateKeyToAccount(cfg.relayerKey);
  const wallet = createWalletClient({ chain, transport, account });
  const address = cfg.contract;

  // One relayer, one nonce sequence: serialize writes.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };

  const write = (functionName: "submitCode" | "submitReceipt", args: readonly unknown[]): Promise<TransactionReceipt> =>
    serial(async () => {
      try {
        // Simulate first so reverts surface with their custom error name.
        const { request } = await pub.simulateContract({
          address,
          abi: bountyEscrowAbi,
          functionName,
          args: args as never,
          account,
        });
        const hash = await wallet.writeContract(request);
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new ChainError(`${functionName} reverted`, "reverted");
        return receipt;
      } catch (e) {
        if (e instanceof ChainError) throw e;
        const reason = revertReason(e);
        throw new ChainError(`${functionName} reverted: ${reason}`, reason);
      }
    });

  const txReceipt = async (hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 }).catch(() => null);
    if (!r) throw new ChainError(`transaction ${hash} not found`);
    if (r.status !== "success") throw new ChainError(`transaction ${hash} reverted`);
    return r;
  };
  const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  return {
    chainId: cfg.chainId,
    contract: address,

    async verifyFunding(txHash, expected) {
      const r = await txReceipt(txHash);
      const [ev] = parseEventLogs({ abi: bountyEscrowAbi, logs: r.logs, eventName: "BountyCreated" }).filter((l) =>
        sameAddr(l.address, address),
      );
      if (!ev) throw new ChainError("transaction did not create a bounty on this contract");
      const a = ev.args;
      if (!sameAddr(a.creator, expected.creator)) throw new ChainError("onchain creator does not match");
      if (a.specHash.toLowerCase() !== expected.specHash.toLowerCase()) throw new ChainError("onchain specHash does not match");
      if (a.testSuiteHash.toLowerCase() !== expected.testSuiteHash.toLowerCase())
        throw new ChainError("onchain testSuiteHash does not match");
      if (a.amount !== parseUnits(expected.amountUsdc, 6)) throw new ChainError("onchain amount does not match");
      if (Number(a.deadline) !== expected.deadline) throw new ChainError("onchain deadline does not match");
      return { onchainId: a.bountyId.toString() };
    },

    async registerSubmission(bountyOnchainId, commitHash, payoutAddress) {
      const r = await write("submitCode", [BigInt(bountyOnchainId), commitHashToBytes32(commitHash), payoutAddress]);
      const [ev] = parseEventLogs({ abi: bountyEscrowAbi, logs: r.logs, eventName: "SubmissionRegistered" });
      if (!ev) throw new ChainError("submitCode emitted no SubmissionRegistered event");
      return { onchainId: ev.args.submissionId.toString(), txHash: r.transactionHash };
    },

    async relayReceipt(rcpt) {
      const r = await write("submitReceipt", [toReceiptMessage(rcpt), rcpt.signature]);
      return { txHash: r.transactionHash };
    },

    receiptDigest(rcpt) {
      try {
        const message = toReceiptMessage(rcpt);
        return hashTypedData({
          domain: receiptDomain(cfg.chainId, address),
          types: receiptTypes,
          primaryType: receiptPrimaryType(message.receiptType),
          message,
        });
      } catch {
        return null;
      }
    },

    async submissionState(onchainId) {
      const s = await pub.readContract({ address, abi: bountyEscrowAbi, functionName: "getSubmission", args: [BigInt(onchainId)] });
      const state = WORKFLOW_STATES[s.state];
      if (!state) throw new ChainError(`unknown onchain state ${s.state}`);
      return state;
    },

    async verifyPayout(txHash, submissionOnchainId) {
      const r = await txReceipt(txHash);
      const [ev] = parseEventLogs({ abi: bountyEscrowAbi, logs: r.logs, eventName: "PayoutReleased" }).filter(
        (l) => sameAddr(l.address, address) && l.args.submissionId.toString() === submissionOnchainId,
      );
      if (!ev) throw new ChainError("transaction did not pay out this submission");
      return { to: ev.args.to as Hex, amount: ev.args.amount, from: r.from as Address as Hex };
    },
  };
}

/** Builds the chain client from env, or returns undefined when no chain is configured. */
export function chainFromEnv(env: NodeJS.ProcessEnv = process.env): ChainClient | undefined {
  const contract = env.BOUNTY_CONTRACT_ADDRESS?.trim();
  const relayerKey = env.RELAYER_PRIVATE_KEY?.trim();
  if (!contract || !relayerKey) return undefined;
  return createChainClient({
    rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
    chainId: Number(env.CHAIN_ID ?? 31337),
    contract: contract as Hex,
    relayerKey: relayerKey as Hex,
  });
}
