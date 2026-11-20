import type { ApiBounty, ApiSubmission } from "@abm/shared";
import { AnthropicLlm, type Llm } from "../llm";
import { readSourceTree, reviewSource, type ReviewResult } from "./reviewer";

/**
 * Adapter for the runner's `SecurityReviewer` plug-in (packages/runner/src/security.ts).
 * The runner signs the SecurityReviewReceipt itself with REVIEWER_SIGNER_PRIVATE_KEY; this only decides pass/fail.
 *
 *   SECURITY_REVIEWER_MODULE=../../agents/src/review/runner-reviewer.ts   (resolved from packages/runner/src)
 *
 * Uses Claude when ANTHROPIC_API_KEY is set (model from ABM_REVIEW_MODEL), otherwise static checks only.
 * Shapes mirror the runner's interface so this package does not depend on @abm/runner.
 */
export interface RunnerReviewInput {
  dir: string;
  bounty: ApiBounty;
  submission: ApiSubmission;
}

export interface RunnerReviewResult {
  passed: boolean;
  report: string;
  /** Goes into the receipt's runnerVersion: [A-Za-z0-9._-] only. */
  reviewer: string;
}

export function formatReport(r: ReviewResult): string {
  const lines = r.findings.map(
    (f) => `${f.severity.toUpperCase()} [${f.source}:${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.message}${f.snippet ? `: ${f.snippet}` : ""}`,
  );
  return [r.summary, ...lines].join("\n");
}

const reviewerId = (llm: Llm | undefined) => `abm-review.${llm ? llm.name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) : "static"}`;

export function createRunnerReviewer(llm?: Llm) {
  return {
    async review({ dir, bounty }: RunnerReviewInput): Promise<RunnerReviewResult> {
      const result = await reviewSource(await readSourceTree(dir), { llm, spec: bounty.spec });
      return { passed: result.pass, report: formatReport(result), reviewer: reviewerId(llm) };
    },
  };
}

const envLlm = (env: NodeJS.ProcessEnv): Llm | undefined =>
  env.ANTHROPIC_API_KEY ? new AnthropicLlm({ model: env.ABM_REVIEW_MODEL || undefined }) : undefined;

export default createRunnerReviewer(envLlm(process.env));
