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
    state: z.enum(["OPEN", "AWARDED", "REFUNDED"]).optional().describe("Filter by state; defaults to OPEN"),
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

const handlers: Handlers = {
  list_bounties: async (api, { state }) =>
    (await api.listBounties(state ?? "OPEN")).map((b) => ({
      id: b.id,
      title: b.title,
      amountUsdc: b.amountUsdc,
      deadline: b.deadline,
      state: b.state,
      submissionCount: b.submissionCount,
    })),
  get_bounty_spec: async (api, { bountyId }) => {
    const b = await api.getBounty(bountyId);
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
      funded: b.onchainId !== null,
      onchainId: b.onchainId,
      submissionCount: b.submissionCount,
      howToSubmit: [
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
    return describeSubmission(submission, runs, receipts);
  },
  request_test_run: (api, { submissionId }) => api.requestRun(submissionId, "test"),
  request_security_review: (api, { submissionId }) => api.requestRun(submissionId, "security"),
};

/** Build step the runner always runs before the bounty's test command (see packages/runner/src/job.ts). */
const BUILD_COMMAND = "npm run build --if-present";

/** What the agent should do next, in one sentence. */
export function nextStep(s: ApiSubmission, runs: ApiRun[]): string {
  const { build, test, security } = s.checks;
  if (s.state === "PAYOUT") return "Done: the creator accepted and the payout was sent.";
  if ([build, test, security].includes("running")) return "A sandbox run is in progress. Poll again in a few seconds.";
  if (build === "failed") return "Build failed. Read lastRun.logs, fix it, commit, and submit_code again with the new commit.";
  if (test === "failed") return "Tests failed. Read lastRun.logs for the failing output, fix it, commit, and submit_code again.";
  if (security === "failed") return "Security review failed. Read lastRun.logs for the findings, fix them, commit, and submit_code again.";
  if ([build, test, security].includes("error")) return `The runner errored: ${runs.at(-1)?.error ?? "unknown"}. Retry later or submit again.`;
  if (s.state === "CODE_SUBMITTED") return "Waiting for the build/test run. Call request_test_run if nothing starts.";
  if (s.state === "TESTS_VERIFIED") return "Tests verified. Waiting for security review; call request_security_review if nothing starts.";
  if (s.state === "SECURITY_REVIEWED") return "All checks verified onchain. Waiting for the creator to accept.";
  return "Waiting.";
}

function describeSubmission(s: ApiSubmission, runs: ApiRun[], receipts: ApiReceipt[]) {
  const last = runs.at(-1);
  return {
    id: s.id,
    bountyId: s.bountyId,
    agentId: s.agentId,
    commitHash: s.commitHash,
    payoutAddress: s.payoutAddress,
    workflowState: s.state,
    checks: s.checks,
    nextStep: nextStep(s, runs),
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
  list_bounties: "List bounties (open ones by default) with reward and deadline.",
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

export function registerTools(server: McpServer, api: BountyApi): void {
  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: toolInputs[name].shape,
        annotations: { readOnlyHint: name.startsWith("get_") || name === "list_bounties" || name === "download_repository", openWorldHint: false },
      },
      // The SDK validates against the shape; callTool re-validates with the strict schema (rejects unknown keys).
      (args: unknown) => callTool(api, name, args),
    );
  }
}
