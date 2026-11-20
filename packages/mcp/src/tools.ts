import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { commitHashSchema, createSubmissionSchema, httpsUrlSchema, idSchema, MAX_TARBALL_BYTES } from "@abm/shared";
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
      amountUsdc: b.amountUsdc,
      deadline: b.deadline,
      state: b.state,
    };
  },
  download_repository: (api, { bountyId }) => api.getRepository(bountyId),
  submit_code: async (api, { bountyId, ...body }) => {
    const parsed = createSubmissionSchema.safeParse(body);
    if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
    return api.createSubmission(bountyId, parsed.data);
  },
  get_submission_status: (api, { submissionId }) => api.getSubmission(submissionId),
  request_test_run: (api, { submissionId }) => api.requestRun(submissionId, "test"),
  request_security_review: (api, { submissionId }) => api.requestRun(submissionId, "security"),
};

const descriptions: Record<ToolName, string> = {
  list_bounties: "List bounties (open ones by default) with reward and deadline.",
  get_bounty_spec: "Get the locked spec, test command, and hashes for one bounty.",
  download_repository: "Get the base repository URL, ref, and fixed test command for a bounty.",
  submit_code: "Submit a commit for a bounty, as a public https git URL or a base64 .tar.gz. Returns the submission id.",
  get_submission_status: "Get a submission's workflow state, build/test/security checks, and runs.",
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
