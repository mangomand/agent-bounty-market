import { WORKFLOW_STATES, type ReceiptType, type WorkflowState } from "@abm/shared";
import type { SubmissionView } from "./api/types";

const ELLIPSIS = "…";

/** `0x3f9a1c…b27e` — keeps the 0x prefix, `head` hex chars, and `tail` hex chars. */
export function shortHash(hash: string, head = 6, tail = 4): string {
  const prefix = hash.startsWith("0x") ? "0x" : "";
  const body = prefix ? hash.slice(2) : hash;
  if (body.length <= head + tail + 1) return hash;
  return `${prefix}${body.slice(0, head)}${ELLIPSIS}${body.slice(-tail)}`;
}

/** Git-style 7 char commit. */
export function shortCommit(commit: string): string {
  return (commit.startsWith("0x") ? commit.slice(2) : commit).slice(0, 7);
}

/** USDC base units (6 decimals, decimal string) → `1,250.00 USDC`. */
export function formatUsdc(baseUnits: string, withUnit = true): string {
  let units: bigint;
  try {
    units = BigInt(baseUnits);
  } catch {
    return withUnit ? `${baseUnits} USDC` : baseUnits;
  }
  const negative = units < 0n;
  if (negative) units = -units;
  const whole = units / 1_000_000n;
  const cents = (units % 1_000_000n) / 10_000n;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = `${negative ? "-" : ""}${wholeStr}.${cents.toString().padStart(2, "0")}`;
  return withUnit ? `${out} USDC` : out;
}

/** Unix seconds → `in 2d 4h`, `in 35m`, `3h ago`, `now`. */
export function formatRelative(unixSeconds: number, nowMs: number = Date.now()): string {
  const diff = unixSeconds - Math.floor(nowMs / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return "now";
  const d = Math.floor(abs / 86_400);
  const h = Math.floor((abs % 86_400) / 3_600);
  const m = Math.floor((abs % 3_600) / 60);
  const span = d > 0 ? (h > 0 ? `${d}d ${h}h` : `${d}d`) : h > 0 ? (m > 0 && h < 6 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** Unix seconds → `14:03:22` (local time). */
export function formatClock(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Cut to `width` display columns, ending with `…` when cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width === 1) return ELLIPSIS;
  return chars.slice(0, width - 1).join("") + ELLIPSIS;
}

/** Pad or truncate to exactly `width` columns. */
export function fit(text: string, width: number, align: "left" | "right" = "left"): string {
  const t = truncate(text, width);
  const pad = " ".repeat(Math.max(0, width - Array.from(t).length));
  return align === "left" ? t + pad : pad + t;
}

// ---------------------------------------------------------------------------
// Workflow progress

/** Steps a submission moves through. BOUNTY_CREATED belongs to the bounty itself. */
export const SUBMISSION_STEPS: readonly WorkflowState[] = WORKFLOW_STATES.filter((s) => s !== "BOUNTY_CREATED");

export const STEP_LABEL: Record<WorkflowState, string> = {
  BOUNTY_CREATED: "Created",
  CODE_SUBMITTED: "Submitted",
  BUILD_VERIFIED: "Build",
  TESTS_VERIFIED: "Tests",
  SECURITY_REVIEWED: "Security",
  CREATOR_ACCEPTED: "Accepted",
  PAYOUT: "Paid",
};

/** What is happening while a submission is working toward a state. */
export const STEP_ACTIVITY: Record<WorkflowState, string> = {
  BOUNTY_CREATED: "creating bounty",
  CODE_SUBMITTED: "receiving code",
  BUILD_VERIFIED: "building",
  TESTS_VERIFIED: "running tests",
  SECURITY_REVIEWED: "security review",
  CREATOR_ACCEPTED: "awaiting creator",
  PAYOUT: "releasing payout",
};

export const RECEIPT_LABEL: Record<ReceiptType, string> = {
  BuildReceipt: "Build",
  TestReceipt: "Tests",
  SecurityReviewReceipt: "Security",
  CreatorAcceptance: "Acceptance",
};

/**
 * - done:    verified
 * - active:  being verified right now (spinner)
 * - waiting: blocked on a person (creator acceptance)
 * - failed:  verification failed; workflow stops here
 * - todo:    not reached
 * - skipped: not reached and never will be (rejected or closed)
 */
export type StepStatus = "done" | "active" | "waiting" | "failed" | "todo" | "skipped";

export interface Step {
  state: WorkflowState;
  label: string;
  status: StepStatus;
}

export function stepsFor(sub: Pick<SubmissionView, "state" | "status">): Step[] {
  const reached = SUBMISSION_STEPS.indexOf(sub.state);
  return SUBMISSION_STEPS.map((state, i): Step => {
    let status: StepStatus;
    if (i <= reached) status = "done";
    else if (i === reached + 1) {
      status =
        sub.status === "running"
          ? "active"
          : sub.status === "waiting"
            ? "waiting"
            : sub.status === "rejected"
              ? "failed"
              : "skipped";
    } else status = sub.status === "rejected" || sub.status === "closed" ? "skipped" : "todo";
    return { state, label: STEP_LABEL[state], status };
  });
}

/** One-line description of where a submission is. */
export function statusText(sub: Pick<SubmissionView, "state" | "status" | "reason">): string {
  const next = SUBMISSION_STEPS[SUBMISSION_STEPS.indexOf(sub.state) + 1];
  switch (sub.status) {
    case "paid":
      return "paid";
    case "closed":
      return "closed";
    case "waiting":
      return "awaiting creator";
    case "rejected":
      return `rejected at ${next ? STEP_LABEL[next].toLowerCase() : "?"}${sub.reason ? `: ${sub.reason}` : ""}`;
    case "running":
      return next ? STEP_ACTIVITY[next] : "finishing";
  }
}

/** Plain glyphs. They carry the meaning on their own so output reads fine without color. */
export const GLYPH: Record<Exclude<StepStatus, "active">, string> = {
  done: "✓",
  waiting: "◷",
  failed: "✗",
  todo: "·",
  skipped: "·",
};
