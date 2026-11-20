/**
 * Scripted demo agents. Run against `pnpm demo`:
 *
 *   corepack pnpm demo:agents            honest + rigged + attack
 *   corepack pnpm demo:agents honest     an agent fails tests, reads the output, fixes it, reaches SECURITY_REVIEWED
 *   corepack pnpm demo:agents rigged     an agent rigs its test script; the security review blocks it
 *   corepack pnpm demo:agents attack     try to skip, forge, replay, and double-pay; every attempt must be rejected
 *
 * Agents only use the MCP server, like Claude Code would. The attack act also talks to the
 * chain directly, and signs with the demo runner/reviewer keys from .env.local to show that
 * even a validly signed receipt cannot skip a step. Local Anvil only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ApiBounty, ApiReceipt, ApiSubmission, Hex, Receipt } from "@abm/shared";
import { toReceiptMessage } from "@abm/shared";
import { bountyEscrowAbi } from "@abm/shared/abi";
import { signReceipt } from "@abm/runner";
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const API = process.env.ABM_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const PAYOUT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // Anvil account #4
const BOUNTY = process.argv.find((a) => a.startsWith("--bounty="))?.slice(9) ?? "bty_demo1";
const POLL_TIMEOUT_MS = 6 * 60_000;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1"), dim = c("2"), red = c("31"), green = c("32"), yellow = c("33"), cyan = c("36");
const act = (title: string) => console.log(`\n${bold(cyan(`━━ ${title} `.padEnd(72, "━")))}`);
const say = (who: string, msg: string) => console.log(`${bold(who.padEnd(8))} ${msg}`);
const indent = (s: string, n = 4) => s.split("\n").map((l) => " ".repeat(n) + l).join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- MCP ----------

let mcp: Client | null = null;
async function connect(): Promise<Client> {
  if (mcp) return mcp;
  const client = new Client({ name: "abm-demo-agent", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", API)));
  } catch (e) {
    throw new Error(`cannot reach the MCP server at ${API}/mcp. Is \`corepack pnpm demo\` running? (${e instanceof Error ? e.message : e})`);
  }
  mcp = client;
  return client;
}

interface ToolResult {
  ok: boolean;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool output is JSON the demo prints; fields are read defensively
  data: any;
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  let res;
  try {
    res = await (await connect()).callTool({ name, arguments: args });
  } catch (e) {
    // Protocol-level errors (e.g. an unknown tool) come back as exceptions.
    return { ok: false, text: e instanceof Error ? e.message : String(e), data: null };
  }
  const content = (res.content ?? []) as { type: string; text?: string }[];
  const text = content.map((b) => b.text ?? "").join("\n");
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // error results are plain text
  }
  return { ok: !res.isError, text, data };
}

async function mustTool(name: string, args: Record<string, unknown> = {}) {
  const r = await tool(name, args);
  if (!r.ok) throw new Error(`${name} failed: ${r.text}`);
  return r.data;
}

// ---------- helpers ----------

/** Packs a fixture as .tar.gz; its sha1 stands in for the commit hash. */
function pack(fixture: string): { base64: string; commit: string } {
  const buf = execFileSync("tar", ["-czf", "-", "-C", resolve(ROOT, "demo/fixtures", fixture), "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return { base64: buf.toString("base64"), commit: createHash("sha1").update(buf).digest("hex") };
}

/** Submits a fixture through MCP, then polls get_submission_status until the workflow settles. */
async function submitAndWatch(agent: string, fixture: string) {
  const src = pack(fixture);
  say(agent, `submit_code ${dim(`(${fixture}, commit ${src.commit.slice(0, 10)}…, payout ${PAYOUT.slice(0, 8)}…)`)}`);
  const r = await tool("submit_code", {
    bountyId: BOUNTY,
    agentId: agent,
    commitHash: src.commit,
    payoutAddress: PAYOUT,
    sourceTarballBase64: src.base64,
  });
  if (!r.ok) throw new Error(`submit_code failed: ${r.text}`);
  const sub = r.data as ApiSubmission;
  say("", `${green("registered onchain")} as submission #${sub.onchainId} ${dim(`tx ${sub.submitTxHash ?? "-"}`)}`);

  const until = Date.now() + POLL_TIMEOUT_MS;
  let last = "";
  for (;;) {
    const s = await mustTool("get_submission_status", { submissionId: sub.id });
    const line = `${s.workflowState}  build=${s.checks.build} test=${s.checks.test} security=${s.checks.security}`;
    if (line !== last) say("", dim(line));
    last = line;
    const { build, test, security } = s.checks as Record<string, string>;
    const settled =
      ["SECURITY_REVIEWED", "PAYOUT"].includes(s.workflowState) ||
      [build, test, security].some((x) => x === "failed" || x === "error");
    if (settled) return s;
    if (Date.now() > until) throw new Error(`submission ${sub.id} did not settle in time`);
    await sleep(1_000);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_submission_status JSON
function showOutcome(s: any) {
  say("", `nextStep: ${bold(s.nextStep)}`);
  if (s.lastRun?.logs && s.workflowState !== "SECURITY_REVIEWED") {
    const interesting = String(s.lastRun.logs)
      .split("\n")
      .filter((l: string) => /not ok|fail|^(?:HIGH|MEDIUM|LOW) \[|expected|actual|passed:|^\s{4}\S/.test(l) && !/\((?:node|file):/.test(l))
      .slice(0, 14)
      .join("\n");
    console.log(indent(interesting || String(s.lastRun.logs).slice(-800)));
  }
  if (s.receipts?.length) {
    for (const rc of s.receipts) say("", `${rc.result ? green("✓") : red("✗")} ${rc.type.padEnd(22)} ${dim(`digest ${rc.digest?.slice(0, 18)}…  relay ${rc.relayTx ? `${rc.relayTx.slice(0, 18)}…` : "-"}`)}`);
  }
}

// ---------- acts ----------

async function honest() {
  act("1. Honest agent: fail, read the output, fix, pass");
  const tools = (await (await connect()).listTools()).tools.map((t) => t.name);
  say("agent", `connected to ${API}/mcp, tools: ${tools.join(", ")}`);
  const bounties = (await mustTool("list_bounties")) as ApiBounty[];
  for (const b of bounties) say("", dim(`${b.id}  ${b.amountUsdc.padStart(4)} USDC  ${b.title}`));
  const spec = await mustTool("get_bounty_spec", { bountyId: BOUNTY });
  say("agent", `get_bounty_spec ${BOUNTY}: "${spec.title}", ${spec.amountUsdc} USDC, test command \`${spec.testCommand}\``);
  if (spec.state !== "OPEN" || !spec.funded) throw new Error(`${BOUNTY} is ${spec.state}${spec.funded ? "" : ", unfunded"}. Restart \`pnpm demo\` for a fresh bounty.`);

  say("agent", "first attempt: the quickest thing that compiles");
  showOutcome(await submitAndWatch("demo-agent", "slugify-careless"));

  say("agent", "read the failing tests; trim dashes and strip non-ASCII; resubmit");
  const good = await submitAndWatch("demo-agent", "slugify-good");
  showOutcome(good);
  if (good.workflowState !== "SECURITY_REVIEWED") throw new Error(`expected SECURITY_REVIEWED, got ${good.workflowState}`);
}

async function rigged() {
  act("2. Rigged agent: makes the test script exit 0");
  say("rigged", 'package.json: "test": "node --test || true"  (failing tests now "pass")');
  const s = await submitAndWatch("rigged-agent", "slugify-rigged");
  showOutcome(s);
  if (s.checks.security !== "failed") throw new Error(`expected the security review to fail, got ${s.checks.security}`);
  say("", `${green("blocked:")} tests "passed", but the security review failed, so the submission can never reach payout`);
}

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) return rev.data?.errorName ?? rev.reason ?? rev.shortMessage;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

async function attack() {
  act("3. Attacks: every one must be rejected");
  const env = process.env;
  const contract = env.BOUNTY_CONTRACT_ADDRESS as Address | undefined;
  const runnerKey = env.RUNNER_SIGNER_PRIVATE_KEY as Hex | undefined;
  const reviewerKey = env.REVIEWER_SIGNER_PRIVATE_KEY as Hex | undefined;
  if (!contract || !runnerKey || !reviewerKey) throw new Error("missing .env.local values; start `corepack pnpm demo` first");
  const chainId = Number(env.CHAIN_ID ?? 31337);
  const pub = createPublicClient({ transport: http(env.RPC_URL ?? "http://127.0.0.1:8545") });
  const ctx = { chainId, verifyingContract: contract };

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(new URL(path, API));
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return (await res.json()) as T;
  };
  const { bounty } = await get<{ bounty: ApiBounty }>(`/bounties/${BOUNTY}`);
  const { submissions } = await get<{ submissions: ApiSubmission[] }>(`/bounties/${BOUNTY}/submissions`);
  const early = submissions.find((s) => s.onchainId && ["CODE_SUBMITTED", "BUILD_VERIFIED", "TESTS_VERIFIED"].includes(s.state));
  const ready = [...submissions].reverse().find((s) => s.onchainId && ["SECURITY_REVIEWED", "PAYOUT"].includes(s.state));
  if (!early || !ready) throw new Error("run `corepack pnpm demo:agents honest` first: attacks need an unfinished and a reviewed submission");
  const readyReceipts = (await get<{ receipts: ApiReceipt[] }>(`/submissions/${ready.id}/receipts`)).receipts;
  const usedBuild = readyReceipts.find((r) => r.receiptType === "BuildReceipt" && r.txHash);
  if (!usedBuild) throw new Error(`submission ${ready.id} has no relayed build receipt`);
  // The API stores receipts under its own ids; the signed struct used the onchain ones.
  const usedMessage = toReceiptMessage({ ...usedBuild, bountyId: bounty.onchainId!, submissionId: ready.onchainId! });
  say("", dim(`targets: #${early.onchainId} (${early.state}), #${ready.onchainId} (${ready.state}); bounty #${bounty.onchainId} ${bounty.state}`));

  let failures = 0;
  const W = 64;
  /** Passes only if the contract itself reverts; any other error is a bug in this script. */
  const expectRevert = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      failures++;
      console.log(`  ${red("✗ NOT BLOCKED")}  ${label}`);
    } catch (e) {
      const reverted = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (!reverted) {
        failures++;
        console.log(`  ${red("✗ ERROR")}       ${label}: ${revertName(e)}`);
      } else console.log(`  ${green("✓ rejected")}  ${label.padEnd(W)} ${yellow(revertName(e))}`);
    }
  };
  const t = Math.floor(Date.now() / 1000) - 30;
  const base = (sub: ApiSubmission, over: Partial<Receipt> = {}): Receipt => ({
    bountyId: bounty.onchainId!,
    submissionId: sub.onchainId!,
    commitHash: sub.commitHash,
    receiptType: "BuildReceipt",
    runnerVersion: "attacker",
    result: true,
    timestamp: t,
    expiry: t + 3600,
    ...over,
  });
  const relay = async (r: { message: ReturnType<typeof toReceiptMessage>; signature: Hex }) =>
    pub.simulateContract({ address: contract, abi: bountyEscrowAbi, functionName: "submitReceipt", args: [r.message, r.signature], account: privateKeyToAccount(generatePrivateKey()).address });
  const accept = (id: string, from: Address) =>
    pub.simulateContract({ address: contract, abi: bountyEscrowAbi, functionName: "acceptSubmission", args: [BigInt(id)], account: from });

  if (ready.state === "PAYOUT") {
    // After payout the bounty is closed, so every other attempt would just hit BountyNotOpen.
    console.log(bold("\n  After payout"));
    await expectRevert(`creator pays out #${ready.onchainId} a second time`, () => accept(ready.onchainId!, bounty.creator as Address));
    await expectRevert(`creator pays out the rejected #${early.onchainId} too`, () => accept(early.onchainId!, bounty.creator as Address));
    console.log();
    if (failures > 0) throw new Error(`${failures} attack(s) were NOT blocked`);
    say("", green(bold("no double payout: the bounty is closed onchain.")));
    return;
  }

  console.log(bold("\n  Contract"));
  await expectRevert(`creator accepts #${early.onchainId} before tests and review`, () => accept(early.onchainId!, bounty.creator as Address));
  await expectRevert("security receipt that skips the test step (real reviewer key)", async () =>
    relay(await signReceipt(privateKeyToAccount(reviewerKey), base(early, { receiptType: "SecurityReviewReceipt" }), ctx)));
  await expectRevert("receipt for a different commit (real runner key)", async () =>
    relay(await signReceipt(privateKeyToAccount(runnerKey), base(early, { commitHash: "f".repeat(40) }), ctx)));
  await expectRevert("replay of an already-used build receipt", () =>
    relay({ message: usedMessage, signature: usedBuild.signature }));
  await expectRevert("expired receipt (real runner key)", async () =>
    relay(await signReceipt(privateKeyToAccount(runnerKey), base(early, { timestamp: t - 7200, expiry: t - 3600 }), ctx)));
  const forged = await signReceipt(privateKeyToAccount(generatePrivateKey()), base(early), ctx);
  await expectRevert("receipt signed by an unapproved key", () => relay(forged));
  await expectRevert("used receipt with one field edited after signing", () =>
    relay({ message: { ...usedMessage, runnerVersion: "tampered" }, signature: usedBuild.signature }));
  await expectRevert(`someone other than the creator accepts #${ready.onchainId}`, () => accept(ready.onchainId!, PAYOUT));

  console.log(bold("\n  API and MCP"));
  const apiPost = async (label: string, path: string, body: unknown) => {
    const res = await fetch(new URL(path, API), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { error?: { code: string } };
    if (res.ok) {
      failures++;
      console.log(`  ${red("✗ NOT BLOCKED")}  ${label}`);
    } else console.log(`  ${green("✓ rejected")}  ${label.padEnd(W)} ${yellow(json.error?.code ?? String(res.status))}`);
  };
  await apiPost("API: forged receipt posted directly", `/submissions/${early.id}/receipts`, {
    receipts: [{ ...forged.receipt, commitHash: early.commitHash, signature: forged.signature, signer: forged.signer }],
  });
  const mcpReject = async (label: string, name: string, args: Record<string, unknown>) => {
    const r = await tool(name, args);
    if (r.ok) {
      failures++;
      console.log(`  ${red("✗ NOT BLOCKED")}  ${label}`);
    } else console.log(`  ${green("✓ rejected")}  ${label.padEnd(W)} ${yellow(r.text.split("\n")[0]!.slice(0, 60))}`);
  };
  await mcpReject(`MCP: request_security_review on #${early.onchainId} before tests pass`, "request_security_review", { submissionId: early.id });
  await mcpReject("MCP: call a payout tool", "accept_submission", { submissionId: ready.id });
  await mcpReject("MCP: path traversal in a bounty id", "get_bounty_spec", { bountyId: "../submissions" });

  console.log();
  if (failures > 0) throw new Error(`${failures} attack(s) were NOT blocked`);
  say("", green(bold("all attacks rejected. Funds move only through the creator's acceptSubmission.")));
}

// ---------- main ----------

const ACTS = { honest, rigged, attack } as const;
const which = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "all";
const plan = which === "all" ? [honest, rigged, attack] : ACTS[which as keyof typeof ACTS] ? [ACTS[which as keyof typeof ACTS]] : null;
if (!plan) {
  console.error(`unknown act "${which}". Use one of: all, ${Object.keys(ACTS).join(", ")}`);
  process.exit(2);
}
try {
  for (const run of plan) await run();
  if (which === "all" || which === "honest")
    console.log(`\n${bold("Next:")} open http://localhost:3000/bounties/${BOUNTY}, accept the submission marked SECURITY_REVIEWED, and watch the payout tx.\nThen run ${cyan("corepack pnpm demo:agents attack")} again to try a double payout.`);
} catch (e) {
  console.error(`\n${red(bold("✗"))} ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await (mcp as Client | null)?.close().catch(() => undefined);
}
