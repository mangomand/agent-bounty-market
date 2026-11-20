import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  addressSchema,
  commitHashSchema,
  createSubmissionSchema,
  httpsUrlSchema,
  idSchema,
  MAX_TARBALL_BYTES,
  type ApiBounty,
  type ApiReceipt,
  type ApiRun,
  type ApiSubmission,
} from "@abm/shared";
import { ApiClientError, type BountyApi } from "./api-client";

/**
 * The only tools this server exposes. Agents are untrusted: every input is validated with zod,
 * and nothing here can send transactions, accept or modify bounties, or touch keys.
 */
export const TOOL_NAMES = [
  "list_bounties",
  "get_bounty_spec",
  "download_repository",
  "submit_code",
  "get_submission_status",
  "request_test_run",
  "request_security_review",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const bountyId = idSchema("bty").describe("Bounty id, e.g. bty_demo1");
const submissionId = idSchema("sub").describe("Submission id returned by submit_code");

export const toolInputs = {
  list_bounties: z.strictObject({
    state: z
      .enum(["OPEN", "AWARDED", "REFUNDED"])
      .optional()
      .describe("Filter by state. Omit to list only bounties still accepting submissions (OPEN and before the deadline)."),
  }),
  get_bounty_spec: z.strictObject({ bountyId }),
  download_repository: z.strictObject({ bountyId }),
  submit_code: z.strictObject({
    bountyId,
    agentId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).describe("Your agent name, 1-64 chars of [A-Za-z0-9._-]"),
    commitHash: commitHashSchema.describe("Full lowercase git commit hash of the code being submitted"),
    payoutAddress: addressSchema.describe("0x address that receives the USDC payout if the creator accepts. Locked onchain at submit."),
    repoUrl: httpsUrlSchema.optional().describe("Public https git URL containing commitHash"),
    sourceTarballBase64: z
      .string()
      .max(Math.ceil(MAX_TARBALL_BYTES / 3) * 4)
      .optional()
      .describe("Base64 .tar.gz of the source tree (max 10 MB). Use instead of repoUrl."),
  }),
  get_submission_status: z.strictObject({ submissionId }),
  request_test_run: z.strictObject({ submissionId }),
  request_security_review: z.strictObject({ submissionId }),
} satisfies Record<ToolName, z.ZodObject>;

type Handlers = { [K in ToolName]: (api: BountyApi, args: z.infer<(typeof toolInputs)[K]>) => Promise<unknown> };

const nowSec = () => Math.floor(Date.now() / 1000);

/** A bounty takes submissions only while OPEN and before its deadline (same rule as POST /bounties/:id/submissions). */
export function acceptingSubmissions(b: Pick<ApiBounty, "state" | "deadline">, now = nowSec()): boolean {
  return b.state === "OPEN" && b.deadline > now;
}

/** Why a bounty no longer takes submissions, or null if it does. */
function closedReason(b: Pick<ApiBounty, "state" | "deadline">): string | null {
  if (b.state === "REFUNDED") return "Closed: the creator refunded this bounty after its deadline. It will not pay out.";
  if (b.state === "AWARDED") return "Closed: another submission was accepted and paid.";
  if (!acceptingSubmissions(b)) return "Closed: the deadline has passed. The creator may refund it.";
  return null;
}

const handlers: Handlers = {
  list_bounties: async (api, { state }) =>
    (await api.listBounties(state ?? "OPEN"))
      .filter((b) => state !== undefined || acceptingSubmissions(b))
      .map((b) => ({
        id: b.id,
        title: b.title,
        amountUsdc: b.amountUsdc,
        deadline: b.deadline,
        state: b.state,
        acceptingSubmissions: acceptingSubmissions(b),
        submissionCount: b.submissionCount,
      })),
  get_bounty_spec: async (api, { bountyId }) => {
    const b = await api.getBounty(bountyId);
    const closed = closedReason(b);
    return {
      id: b.id,
      title: b.title,
      description: b.description,
      spec: b.spec,
      specHash: b.specHash,
      testSuiteHash: b.testSuiteHash,
      testCommand: b.testCommand,
      buildCommand: BUILD_COMMAND,
      repoUrl: b.repoUrl,
      repoRef: b.repoRef,
      allowNetwork: b.allowNetwork,
      amountUsdc: b.amountUsdc,
      deadline: b.deadline,
      state: b.state,
      acceptingSubmissions: closed === null,
      funded: b.onchainId !== null,
      onchainId: b.onchainId,
      refundTx: b.refundTxHash,
      submissionCount: b.submissionCount,
      howToSubmit: closed ? [closed] : [
        `Make \`${b.testCommand}\` pass locally from the project root. The sandbox runs \`${BUILD_COMMAND}\` then \`${b.testCommand}\` with no network${b.allowNetwork ? " (network allowed for this bounty)" : ""}.`,
        "Commit, then call submit_code with the full commit hash, your payoutAddress, and either a public https repoUrl or sourceTarballBase64 (a .tar.gz of the tree, no node_modules).",
        "Build, tests, and security review start automatically. Poll get_submission_status until it says what to do next.",
      ],
    };
  },
  download_repository: (api, { bountyId }) => api.getRepository(bountyId),
  submit_code: async (api, { bountyId, ...body }) => {
    const parsed = createSubmissionSchema.safeParse(body);
    if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
    return api.createSubmission(bountyId, parsed.data);
  },
  get_submission_status: async (api, { submissionId }) => {
    const [{ submission, runs }, receipts] = await Promise.all([api.getSubmission(submissionId), api.getReceipts(submissionId)]);
    const bounty = await api.getBounty(submission.bountyId).catch(() => null);
    return describeSubmission(submission, runs, receipts, bounty);
  },
  request_test_run: (api, { submissionId }) => api.requestRun(submissionId, "test"),
  request_security_review: (api, { submissionId }) => api.requestRun(submissionId, "security"),
};

/** Build step the runner always runs before the bounty's test command (see packages/runner/src/job.ts). */
const BUILD_COMMAND = "npm run build --if-present";

/** What the agent should do next, in one sentence. */
export function nextStep(s: ApiSubmission, runs: ApiRun[], bounty?: Pick<ApiBounty, "state"> | null): string {
  const { build, test, security } = s.checks;
  if (s.state === "PAYOUT") return "Done: the creator accepted and the payout was sent.";
  if (bounty?.state === "REFUNDED") return "Bounty closed: the creator refunded it after the deadline. Nothing more to do here; pick another with list_bounties.";
  if (bounty?.state === "AWARDED") return "Bounty closed: another submission was accepted and paid. Pick another with list_bounties.";
  if ([build, test, security].includes("running")) return "A sandbox run is in progress. Poll again in a few seconds.";
  if (build === "failed") return "Build failed. Read lastRun.logs, fix it, commit, and submit_code again with the new commit.";
  if (test === "failed") return "Tests failed. Read lastRun.logs for the failing output, fix it, commit, and submit_code again.";
  if (security === "failed") return "Security review failed. Read lastRun.logs for the findings, fix them, commit, and submit_code again.";
  if ([build, test, security].includes("error")) {
    const retry = security === "error" ? "request_security_review" : "request_test_run";
    return `The runner errored (not your code): ${runs.at(-1)?.error ?? "unknown"}. Call ${retry} to retry the same commit.`;
  }
  if (s.state === "CODE_SUBMITTED") return "Waiting for the build/test run. Call request_test_run if nothing starts.";
  if (s.state === "TESTS_VERIFIED") return "Tests verified. Waiting for security review; call request_security_review if nothing starts.";
  if (s.state === "SECURITY_REVIEWED") return "All checks verified onchain. Waiting for the creator to accept.";
  return "Waiting.";
}

function describeSubmission(s: ApiSubmission, runs: ApiRun[], receipts: ApiReceipt[], bounty: ApiBounty | null) {
  const last = runs.at(-1);
  return {
    id: s.id,
    bountyId: s.bountyId,
    bountyState: bounty?.state ?? null,
    agentId: s.agentId,
    commitHash: s.commitHash,
    payoutAddress: s.payoutAddress,
    workflowState: s.state,
    checks: s.checks,
    nextStep: nextStep(s, runs, bounty),
    lastRun: last ? { id: last.id, kind: last.kind, status: last.status, error: last.error, logs: last.logs } : null,
    runs: runs.map((r) => ({ id: r.id, kind: r.kind, status: r.status, error: r.error })),
    receipts: receipts.map((r) => ({
      type: r.receiptType,
      result: r.result,
      digest: r.digest,
      relayTx: r.txHash,
      signer: r.signer,
      runnerVersion: r.runnerVersion,
    })),
    onchain: { submissionId: s.onchainId, submitTx: s.submitTxHash, payoutTx: s.acceptTxHash },
  };
}

const descriptions: Record<ToolName, string> = {
  list_bounties: "List bounties with reward and deadline. By default only ones still accepting submissions; refunded and awarded bounties are closed.",
  get_bounty_spec: "Get the locked spec, build and test commands, reward, and how to submit for one bounty.",
  download_repository: "Get the base repository URL, ref, and fixed test command for a bounty.",
  submit_code:
    "Submit a commit for a bounty, as a public https git URL or a base64 .tar.gz, with the payoutAddress that gets paid on acceptance. Registers it onchain and starts verification. Returns the submission id.",
  get_submission_status:
    "Get a submission's workflow state, checks, next step, the last run's output (failing tests or review findings), and receipt digests.",
  request_test_run: "Start the sandboxed build and test run for a submission (state must be CODE_SUBMITTED).",
  request_security_review: "Start the sandboxed security review for a submission (state must be TESTS_VERIFIED).",
};

export class ToolInputError extends Error {}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** Validate raw arguments and run one tool. Never throws: errors become isError results. */
export async function callTool(api: BountyApi, name: string, rawArgs: unknown): Promise<CallToolResult> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return fail(`unknown tool: ${name}`);
  const tool = name as ToolName;
  const parsed = toolInputs[tool].safeParse(rawArgs ?? {});
  if (!parsed.success) return fail(`invalid input: ${z.prettifyError(parsed.error)}`);
  try {
    // The handler for `tool` takes exactly the type `toolInputs[tool]` parses to; TS cannot correlate the union.
    const handler = handlers[tool] as (api: BountyApi, args: unknown) => Promise<unknown>;
    return ok(await handler(api, parsed.data));
  } catch (e) {
    if (e instanceof ToolInputError) return fail(`invalid input: ${e.message}`);
    if (e instanceof ApiClientError) return fail(`${e.code}: ${e.message}`);
    return fail("API request failed");
  }
}

/**
 * Schema handed to the SDK. The SDK parses arguments with whatever schema it is given before calling the handler,
 * and a plain zod object strips unknown keys there, so our strict check would never see them. Instead the SDK gets a
 * loose object that accepts any arguments unchanged, with the strict schema's JSON Schema (including
 * `additionalProperties: false`) attached as metadata so tools/list still advertises the exact shape.
 * All validation happens in callTool against the strict schema.
 */
function sdkInputSchema(name: ToolName): z.ZodObject {
  // The SDK emits draft-7; drop $schema so the SDK's own header is used.
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(toolInputs[name], { target: "draft-7", io: "input" });
  return z.looseObject({}).meta(jsonSchema);
}

export function registerTools(server: McpServer, api: BountyApi): void {
  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: sdkInputSchema(name),
        annotations: { readOnlyHint: name.startsWith("get_") || name === "list_bounties" || name === "download_repository", openWorldHint: false },
      },
      // Raw arguments reach callTool, which validates with the strict schema and rejects unknown keys by name.
      (args: unknown) => callTool(api, name, args),
    );
  }
}
