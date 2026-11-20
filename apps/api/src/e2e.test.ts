/**
 * End to end on a real local chain: Anvil + BountyEscrow + API + runner (Docker when available).
 * Skipped unless `anvil` and `forge` are on PATH and contracts/lib is installed.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitHashToBytes32, type Hex, type RunnerClient } from "@abm/shared";
import { bountyEscrowAbi, mockUsdcAbi } from "@abm/shared/abi";
import { DockerExecutor, ProcessExecutor, dockerAvailable, runJob, signReceipt, type JobRunnerOptions } from "@abm/runner";
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "./app";
import { createChainClient } from "./chain";
import { openDb } from "./db";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const onPath = (bin: string) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const enabled = onPath("anvil") && onPath("forge") && existsSync(resolve(ROOT, "contracts/lib/openzeppelin-contracts"));

// Anvil's well-known dev keys. Local chain only.
const KEYS = {
  creator: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0 deployer + creator
  runner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1 RUNNER_ROLE
  relayer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2 no role, pays gas
  reviewer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3 REVIEWER_ROLE
} as const satisfies Record<string, Hex>;
const PAYOUT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Hex; // #4, receives the bounty

const tarball = (dir: string) => {
  const buf = execFileSync("tar", ["-czf", "-", "-C", resolve(ROOT, dir), "."]);
  return { base64: buf.toString("base64"), commit: createHash("sha1").update(buf).digest("hex") };
};

describe.skipIf(!enabled)("end to end on Anvil", () => {
  const port = 18545 + Math.floor(Math.random() * 1000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: 31337,
    name: "Anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 });
  const creator = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(KEYS.creator) });
  let anvil: ChildProcess;
  let escrow: Hex;
  let usdc: Hex;
  let t: ReturnType<typeof createApp>;
  let backend = "process";

  const req = async (method: string, path: string, body?: unknown) => {
    const res = await t.app.request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json", host: "localhost" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper; fields are asserted individually
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (await pub.getChainId().then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const out = execFileSync(
      "forge",
      ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", KEYS.creator],
      {
        cwd: resolve(ROOT, "contracts"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          RUNNER_SIGNER_ADDRESS: privateKeyToAccount(KEYS.runner).address,
          REVIEWER_SIGNER_ADDRESS: privateKeyToAccount(KEYS.reviewer).address,
        },
      },
    );
    usdc = out.match(/USDC_ADDRESS=(0x[0-9a-fA-F]{40})/)![1] as Hex;
    escrow = out.match(/BOUNTY_CONTRACT_ADDRESS=(0x[0-9a-fA-F]{40})/)![1] as Hex;

    const useDocker = await dockerAvailable();
    backend = useDocker ? "docker" : "process";
    const opts: JobRunnerOptions = {
      backend,
      // Process fallback only runs our own fixtures here; real runs use Docker.
      executor: useDocker ? new DockerExecutor() : new ProcessExecutor(),
      signing: { chainId: 31337, verifyingContract: escrow },
      runnerSigner: privateKeyToAccount(KEYS.runner),
      reviewerSigner: privateKeyToAccount(KEYS.reviewer),
      runOptions: { now: () => Date.now() - 5_000 },
    };
    const runner: RunnerClient = { run: (job) => runJob(job, opts) };
    t = createApp({
      db: openDb(":memory:"),
      runner,
      chain: createChainClient({ rpcUrl, chainId: 31337, contract: escrow, relayerKey: KEYS.relayer }),
      autoRun: true,
    });
  }, 120_000);

  afterAll(() => {
    anvil?.kill();
  });

  async function postFundedBounty(deadlineIn = 3600) {
    const block = await pub.getBlock();
    const deadline = Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000)) + deadlineIn;
    const specHash = `0x${createHash("sha256").update("slugify spec").digest("hex")}` as Hex;
    const testSuiteHash = `0x${createHash("sha256").update("slugify tests").digest("hex")}` as Hex;
    const amount = parseUnits("50", 6);
    await pub.waitForTransactionReceipt({
      hash: await creator.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "approve", args: [escrow, amount] }),
    });
    const fundTx = await creator.writeContract({
      address: escrow,
      abi: bountyEscrowAbi,
      functionName: "createBounty",
      args: [specHash, testSuiteHash, amount, BigInt(deadline)],
    });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    const b = await req("POST", "/bounties", {
      title: "Add a slugify() utility",
      spec: "slugify spec",
      specHash,
      testSuiteHash,
      amountUsdc: "50",
      deadline,
      creator: creator.account.address,
      testCommand: "npm test",
    });
    expect(b.status).toBe(201);
    // Unfunded until the API has verified the funding tx itself.
    const funded = await req("POST", `/bounties/${b.body.bounty.id}/fund`, { txHash: fundTx });
    expect(funded.status).toBe(200);
    expect(funded.body.bounty.onchainId).toMatch(/^\d+$/);
    return funded.body.bounty as { id: string; onchainId: string; deadline: number };
  }

  const submit = async (bountyId: string, dir: string) => {
    const src = tarball(dir);
    const r = await req("POST", `/bounties/${bountyId}/submissions`, {
      agentId: "e2e",
      commitHash: src.commit,
      payoutAddress: PAYOUT,
      sourceTarballBase64: src.base64,
    });
    expect(r.status).toBe(201);
    return r.body.submission as { id: string; onchainId: string; commitHash: string };
  };

  const onchainState = async (id: string) =>
    (await pub.readContract({ address: escrow, abi: bountyEscrowAbi, functionName: "getSubmission", args: [BigInt(id)] })).state;

  it("rejects a skipped workflow step, then pays the submitter after the full workflow", async () => {
    const bounty = await postFundedBounty();

    // --- Careless submission: builds, fails tests, never becomes payable. ---
    const careless = await submit(bounty.id, "demo/fixtures/slugify-careless");
    expect(careless.onchainId).toMatch(/^\d+$/);
    await t.idle();
    const cs = (await req("GET", `/submissions/${careless.id}`)).body;
    expect(cs.submission.state).toBe("BUILD_VERIFIED");
    expect(cs.submission.checks).toMatchObject({ build: "passed", test: "failed" });
    expect(cs.runs[0].logs).toMatch(/fail 3/);
    expect(await onchainState(careless.onchainId)).toBe(2); // BuildVerified

    // Skipped step: the creator tries to accept before tests and security are verified.
    await expect(
      pub.simulateContract({
        account: creator.account,
        address: escrow,
        abi: bountyEscrowAbi,
        functionName: "acceptSubmission",
        args: [BigInt(careless.onchainId)],
      }),
    ).rejects.toThrow(/InvalidTransition/);

    // Skipped step: a validly signed SecurityReview receipt sent straight after the build.
    const now = Math.floor(Date.now() / 1000) - 5;
    const skip = await signReceipt(
      privateKeyToAccount(KEYS.reviewer),
      {
        bountyId: bounty.onchainId,
        submissionId: careless.onchainId,
        commitHash: careless.commitHash,
        receiptType: "SecurityReviewReceipt",
        runnerVersion: "e2e",
        result: true,
        timestamp: now,
        expiry: now + 600,
      },
      { chainId: 31337, verifyingContract: escrow },
    );
    await expect(
      pub.simulateContract({
        account: creator.account,
        address: escrow,
        abi: bountyEscrowAbi,
        functionName: "submitReceipt",
        args: [skip.message, skip.signature],
      }),
    ).rejects.toThrow(/InvalidTransition/);
    // The API refuses it too, before touching the chain.
    const viaApi = await req("POST", `/submissions/${careless.id}/receipts`, {
      receipts: [{ ...skip.receipt, signature: skip.signature, signer: skip.signer }],
    });
    expect(viaApi.body.error.code).toBe("out_of_order");

    // --- Good submission: full workflow, then creator accepts and the submitter is paid. ---
    const good = await submit(bounty.id, "demo/fixtures/slugify-good");
    await t.idle();
    const gs = (await req("GET", `/submissions/${good.id}`)).body;
    expect(gs.submission.state).toBe("SECURITY_REVIEWED");
    expect(gs.submission.checks).toEqual({ build: "passed", test: "passed", security: "passed" });
    expect(await onchainState(good.onchainId)).toBe(4); // SecurityReviewed

    const receipts = (await req("GET", `/submissions/${good.id}/receipts`)).body.receipts as { receiptType: string; digest: string; txHash: string; runnerVersion: string }[];
    expect(receipts.map((r) => r.receiptType)).toEqual(["BuildReceipt", "TestReceipt", "SecurityReviewReceipt"]);
    for (const r of receipts) {
      expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.runnerVersion).toContain(`+${backend}`);
      // The digest the API shows is the one the contract recorded.
      expect(await pub.readContract({ address: escrow, abi: bountyEscrowAbi, functionName: "receiptUsed", args: [r.digest as Hex] })).toBe(true);
    }
    const onchainSub = await pub.readContract({ address: escrow, abi: bountyEscrowAbi, functionName: "getSubmission", args: [BigInt(good.onchainId)] });
    expect(onchainSub.commitHash).toBe(commitHashToBytes32(good.commitHash));

    const before = await pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [PAYOUT] });
    const acceptTx = await creator.writeContract({
      address: escrow,
      abi: bountyEscrowAbi,
      functionName: "acceptSubmission",
      args: [BigInt(good.onchainId)],
    });
    const acceptReceipt = await pub.waitForTransactionReceipt({ hash: acceptTx });
    expect(parseEventLogs({ abi: bountyEscrowAbi, logs: acceptReceipt.logs, eventName: "PayoutReleased" })).toHaveLength(1);

    // A tx that didn't pay this submission is refused.
    const bogus = await req("POST", `/submissions/${careless.id}/accept`, { creator: creator.account.address, txHash: acceptTx });
    expect(bogus.status).toBeGreaterThanOrEqual(400);

    const accepted = await req("POST", `/submissions/${good.id}/accept`, { creator: creator.account.address, txHash: acceptTx });
    expect(accepted.status).toBe(200);
    expect(accepted.body.bounty).toMatchObject({ state: "AWARDED", payoutTxHash: acceptTx });
    expect(accepted.body.submission.state).toBe("PAYOUT");

    const after = await pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [PAYOUT] });
    expect(after - before).toBe(parseUnits("50", 6));
    expect(await onchainState(good.onchainId)).toBe(6); // Payout

    // An awarded bounty can never be refunded.
    expect((await req("GET", `/bounties/${bounty.id}`)).body.bounty.canRefund).toBe(false);
    await expect(
      pub.simulateContract({ account: creator.account, address: escrow, abi: bountyEscrowAbi, functionName: "refund", args: [BigInt(bounty.onchainId)] }),
    ).rejects.toThrow(/BountyNotOpen/);
  }, 300_000);

  it("refunds the creator after the deadline and mirrors REFUNDED", async () => {
    const bounty = await postFundedBounty(3);
    const refund = () =>
      creator.writeContract({ address: escrow, abi: bountyEscrowAbi, functionName: "refund", args: [BigInt(bounty.onchainId)] });

    expect((await req("GET", `/bounties/${bounty.id}`)).body.bounty.canRefund).toBe(false);
    await expect(
      pub.simulateContract({ account: creator.account, address: escrow, abi: bountyEscrowAbi, functionName: "refund", args: [BigInt(bounty.onchainId)] }),
    ).rejects.toThrow(/DeadlineNotReached/);

    // Real time, not evm_increaseTime: the API's clock and Anvil's block time must agree.
    while (Math.floor(Date.now() / 1000) <= bounty.deadline) await new Promise((r) => setTimeout(r, 250));
    expect((await req("GET", `/bounties/${bounty.id}`)).body.bounty.canRefund).toBe(true);

    const before = await pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [creator.account.address] });
    const refundTx = await refund();
    const receipt = await pub.waitForTransactionReceipt({ hash: refundTx });
    expect(parseEventLogs({ abi: bountyEscrowAbi, logs: receipt.logs, eventName: "BountyRefunded" })).toHaveLength(1);
    const after = await pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [creator.account.address] });
    expect(after - before).toBe(parseUnits("50", 6));

    // A tx that did not refund this bounty is refused.
    const fundTx = (await req("GET", `/bounties/${bounty.id}`)).body.bounty.fundTxHash as Hex;
    expect((await req("POST", `/bounties/${bounty.id}/refund`, { creator: creator.account.address, txHash: fundTx })).status).toBe(422);

    const recorded = await req("POST", `/bounties/${bounty.id}/refund`, { creator: creator.account.address, txHash: refundTx });
    expect(recorded.status).toBe(200);
    expect(recorded.body.bounty).toMatchObject({ state: "REFUNDED", refundTxHash: refundTx, canRefund: false });
    const onchain = await pub.readContract({ address: escrow, abi: bountyEscrowAbi, functionName: "getBounty", args: [BigInt(bounty.onchainId)] });
    expect(onchain.status).toBe(3); // Refunded

    await expect(
      pub.simulateContract({ account: creator.account, address: escrow, abi: bountyEscrowAbi, functionName: "refund", args: [BigInt(bounty.onchainId)] }),
    ).rejects.toThrow(/BountyNotOpen/);
  }, 60_000);
});
