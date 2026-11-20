import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ReactNode } from "react";
import type { BountyView, SubmissionView } from "../api/types";
import { fit, formatRelative, formatUsdc, GLYPH, shortCommit, statusText, stepsFor, truncate, type StepStatus } from "../format";

/**
 * Color has one meaning each: green = verified, red = rejected,
 * yellow = pending. Everything is also spelled out with a glyph or word so
 * output reads the same with NO_COLOR set.
 */
export type Tone = "ok" | "bad" | "pending" | "muted" | "accent" | "plain";

const TONE_COLOR: Record<Tone, string | undefined> = {
  ok: "green",
  bad: "red",
  pending: "yellow",
  muted: "gray",
  accent: "cyan",
  plain: undefined,
};

export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(env.NO_COLOR !== undefined && env.NO_COLOR !== "");
}

export function T({ tone = "plain", bold, children }: { tone?: Tone; bold?: boolean; children?: ReactNode }) {
  const color = colorEnabled() ? TONE_COLOR[tone] : undefined;
  // Without color, "muted" text stays at normal intensity so it remains readable.
  return (
    <Text color={color} bold={bold}>
      {children}
    </Text>
  );
}

export function Spin({ tone = "pending" }: { tone?: Tone }) {
  return (
    <T tone={tone}>
      <Spinner type="dots" />
    </T>
  );
}

const STEP_TONE: Record<StepStatus, Tone> = {
  done: "ok",
  active: "pending",
  waiting: "pending",
  failed: "bad",
  todo: "muted",
  skipped: "muted",
};

function StepGlyph({ status }: { status: StepStatus }) {
  if (status === "active") return <Spin />;
  return <T tone={STEP_TONE[status]}>{GLYPH[status]}</T>;
}

/** `✓ Submitted ─ ✓ Build ─ ⠋ Tests ─ · Security ─ · Accepted ─ · Paid` (66 cols). */
export function Progress({ sub, compact = false }: { sub: Pick<SubmissionView, "state" | "status">; compact?: boolean }) {
  const steps = stepsFor(sub);
  return (
    <Text>
      {steps.map((step, i) => (
        <Text key={step.state}>
          {i > 0 && <T tone="muted">{compact ? " " : " ─ "}</T>}
          <StepGlyph status={step.status} />
          {!compact && <T tone={STEP_TONE[step.status]}> {step.label}</T>}
        </Text>
      ))}
    </Text>
  );
}

const STATUS_TONE: Record<SubmissionView["status"], Tone> = {
  running: "pending",
  waiting: "pending",
  rejected: "bad",
  paid: "ok",
  closed: "muted",
};

export function SubmissionGlyph({ sub }: { sub: SubmissionView }) {
  switch (sub.status) {
    case "running":
      return <Spin />;
    case "waiting":
      return <T tone="pending">{GLYPH.waiting}</T>;
    case "rejected":
      return <T tone="bad">{GLYPH.failed}</T>;
    case "paid":
      return <T tone="ok">{GLYPH.done}</T>;
    case "closed":
      return <T tone="muted">-</T>;
  }
}

/** Two lines: id/agent/commit/status, then the workflow progress line. */
export function SubmissionRow({ sub, width }: { sub: SubmissionView; width: number }) {
  const compact = width < 72;
  const idW = 9;
  const agentW = compact ? 13 : 17;
  // 1 indent + glyph + space + id + agent + commit(7) + 2 gap
  const statusW = Math.max(8, width - (3 + idW + agentW + 9 + 1));
  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        <SubmissionGlyph sub={sub} /> <T bold>{fit(sub.id, idW - 1)} </T>
        {truncate(sub.agentId, agentW - 1).padEnd(agentW)}
        <T tone="muted">{shortCommit(sub.commitHash)}</T>
        {"  "}
        <T tone={STATUS_TONE[sub.status]}>{truncate(statusText(sub), statusW)}</T>
      </Text>
      <Text>
        {"   "}
        <Progress sub={sub} compact={compact} />
      </Text>
    </Box>
  );
}

export const BOUNTY_STATE: Record<BountyView["state"], { label: string; tone: Tone }> = {
  OPEN: { label: "open", tone: "pending" },
  AWARDED: { label: "awarded", tone: "ok" },
  REFUNDED: { label: "refunded", tone: "muted" },
};

export function BountyHeader({ bounty, source, width, now }: { bounty: BountyView; source: string; width: number; now?: number }) {
  const state = BOUNTY_STATE[bounty.state];
  const expired = bounty.state === "OPEN" && bounty.deadline * 1000 < (now ?? Date.now());
  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        <T tone="accent" bold>
          {bounty.id}
        </T>
        {"  "}
        <T bold>{truncate(bounty.title, width - bounty.id.length - 4)}</T>
      </Text>
      <Text>
        {" "}
        <T bold>{formatUsdc(bounty.amountUsdc)}</T>
        <T tone="muted"> · </T>
        {bounty.state === "OPEN" && (
          <>
            {expired ? "deadline passed" : `deadline ${formatRelative(bounty.deadline, now)}`}
            <T tone="muted"> · </T>
          </>
        )}
        <T tone={expired ? "bad" : state.tone}>{expired ? "expired" : state.label}</T>
        <T tone="muted"> · source {source}</T>
      </Text>
    </Box>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <Text>
      {" "}
      <T tone="bad">{GLYPH.failed} </T>
      {message}
    </Text>
  );
}
