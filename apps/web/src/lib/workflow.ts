import { WORKFLOW_STATES, type WorkflowState } from "@abm/shared";
import type { SubmissionView } from "./api/types";

export type CheckName = "build" | "tests" | "security";
export type CheckStatus = "verified" | "failed" | "running" | "pending" | "skipped";

export const CHECKS: { name: CheckName; label: string; state: WorkflowState }[] = [
  { name: "build", label: "Build", state: "BUILD_VERIFIED" },
  { name: "tests", label: "Tests", state: "TESTS_VERIFIED" },
  { name: "security", label: "Security", state: "SECURITY_REVIEWED" },
];

const index = (s: WorkflowState) => WORKFLOW_STATES.indexOf(s);

/**
 * Status of one verification step for a submission, derived from its workflow state.
 * When the bounty is closed, unfinished steps show as pending rather than running.
 */
export function checkStatus(
  sub: Pick<SubmissionView, "state" | "failure">,
  check: WorkflowState,
  bountyClosed = false,
): CheckStatus {
  const current = index(sub.state);
  const target = index(check);
  if (current >= target) return "verified";
  if (sub.failure) {
    const failedAt = index(sub.failure.state);
    if (failedAt === target) return "failed";
    if (failedAt < target) return "skipped";
  }
  return current === target - 1 && !bountyClosed ? "running" : "pending";
}

/** A submission can be accepted once security review is done and nothing failed. */
export function canAccept(sub: Pick<SubmissionView, "state" | "failure">): boolean {
  return sub.state === "SECURITY_REVIEWED" && !sub.failure;
}
