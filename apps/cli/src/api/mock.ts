import { createHash } from "node:crypto";
import { nextState, type ReceiptType, type WorkflowState } from "@abm/shared";
import {
  NotFoundError,
  type BountyClient,
  type BountyEvent,
  type BountyView,
  type Hex,
  type ReceiptView,
  type SubmissionView,
} from "./types";

/**
 * In-memory client with demo data and a simulated pipeline. While anything is
 * subscribed, each tick advances one running submission per bounty by one
 * workflow step, emitting the new submission state and its signed receipt.
 * Once nothing in a bounty is running, the simulated creator accepts the
 * planned winner and the contract pays out.
 */

export const RUNNER_VERSION = "runner@0.3.1";
export const RUNNER_SIGNER: Hex = "0x7a3fB1e04c2D9e6F5a81c0B3d4E29f6A1c58d0E2";
export const MOCK_DEFAULT_TICK_MS = 1100;

const RECEIPT_FOR: Partial<Record<WorkflowState, ReceiptType>> = {
  BUILD_VERIFIED: "BuildReceipt",
  TESTS_VERIFIED: "TestReceipt",
  SECURITY_REVIEWED: "SecurityReviewReceipt",
  CREATOR_ACCEPTED: "CreatorAcceptance",
};

/** Agent behaviour for submissions created through `submit()`. */
const AGENT_PLANS: Record<string, Plan> = {
  "fast-careless": { failAt: "TESTS_VERIFIED", reason: "4 of 18 tests failed" },
  "test-focused": {},
  "security-focused": {},
};

interface Plan {
  /** The step this submission will fail to reach. */
  failAt?: WorkflowState;
  reason?: string;
}

export function mockHash(seed: string): Hex {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}

function mockCommit(seed: string): string {
  return mockHash(`commit:${seed}`).slice(2, 42);
}

function mockSignature(seed: string): Hex {
  return `${mockHash(`sig-r:${seed}`)}${mockHash(`sig-s:${seed}`).slice(2)}1b`;
}

export interface MockClientOptions {
  /** Clock in ms. Defaults to Date.now. */
  now?: () => number;
  /** Simulation step interval. Defaults to ABM_MOCK_TICK_MS or 1100ms. */
  tickMs?: number;
  /** Disable the timer and drive the simulation with tick() (tests). */
  manual?: boolean;
}

export class MockClient implements BountyClient {
  readonly source = "mock";
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly manual: boolean;
  private readonly bounties = new Map<string, BountyView>();
  private readonly subs = new Map<string, SubmissionView>();
  private readonly receipts = new Map<string, ReceiptView[]>();
  private readonly plans = new Map<string, Plan>();
  private readonly winners = new Map<string, string>();
  private readonly cursor = new Map<string, number>();
  private readonly listeners = new Set<{ bountyId: string; fn: (e: BountyEvent) => void }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: MockClientOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? (Number(process.env.ABM_MOCK_TICK_MS) || MOCK_DEFAULT_TICK_MS);
    this.manual = opts.manual ?? false;
    this.seed();
  }

  async listBounties(): Promise<BountyView[]> {
    return [...this.bounties.values()].map((b) => this.withCount(b));
  }

  async getBounty(id: string): Promise<BountyView> {
    const b = this.bounties.get(id);
    if (!b) throw new NotFoundError(`No bounty with id ${id}`);
    return this.withCount(b);
  }

  async listSubmissions(bountyId: string): Promise<SubmissionView[]> {
    if (!this.bounties.has(bountyId)) throw new NotFoundError(`No bounty with id ${bountyId}`);
    return this.subsOf(bountyId).map((s) => ({ ...s }));
  }

  async getReceipts(submissionId: string): Promise<ReceiptView[]> {
    if (!this.subs.has(submissionId)) throw new NotFoundError(`No submission with id ${submissionId}`);
    return (this.receipts.get(submissionId) ?? []).map((r) => ({ ...r }));
  }

  async submit(input: { bountyId: string; agentId: string; commitHash: string }): Promise<SubmissionView> {
    const bounty = this.bounties.get(input.bountyId);
    if (!bounty) throw new NotFoundError(`No bounty with id ${input.bountyId}`);
    if (bounty.state !== "OPEN") throw new Error(`Bounty ${bounty.id} is ${bounty.state.toLowerCase()}`);
    const n = this.subsOf(bounty.id).length;
    const id = `s-${bounty.id.replace(/^b-/, "")}${String.fromCharCode(97 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`;
    const sub: SubmissionView = {
      id,
      bountyId: bounty.id,
      agentId: input.agentId,
      commitHash: input.commitHash,
      state: "CODE_SUBMITTED",
      status: "running",
      createdAt: this.nowSec(),
    };
    this.subs.set(id, sub);
    this.plans.set(id, AGENT_PLANS[input.agentId] ?? {});
    this.emit(bounty.id, { type: "submission", submission: { ...sub } });
    return { ...sub };
  }

  subscribe(bountyId: string, onEvent: (e: BountyEvent) => void): () => void {
    const entry = { bountyId, fn: onEvent };
    this.listeners.add(entry);
    if (!this.manual && !this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
    return () => {
      this.listeners.delete(entry);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  /** Advance the simulation by one step for every bounty. */
  tick(): void {
    for (const bounty of this.bounties.values()) {
      if (bounty.state !== "OPEN") continue;
      const running = this.subsOf(bounty.id).filter((s) => s.status === "running");
      if (running.length > 0) {
        const i = (this.cursor.get(bounty.id) ?? 0) % running.length;
        this.cursor.set(bounty.id, i + 1);
        this.advance(running[i]!);
      } else {
        this.settle(bounty);
      }
    }
  }

  // -------------------------------------------------------------------------

  private advance(sub: SubmissionView): void {
    const target = nextState(sub.state);
    if (!target) return;
    if (target === "PAYOUT") return this.payout(sub);
    const plan = this.plans.get(sub.id) ?? {};
    const t = this.nowSec();
    const type = RECEIPT_FOR[target];
    if (plan.failAt === target) {
      sub.status = "rejected";
      sub.reason = plan.reason;
      if (type) this.addReceipt(sub, type, false, t);
    } else {
      sub.state = target;
      if (type) this.addReceipt(sub, type, true, t);
      if (target === "SECURITY_REVIEWED") sub.status = "waiting";
    }
    this.emit(sub.bountyId, { type: "submission", submission: { ...sub } });
  }

  /** Creator accepts a waiting submission once nothing else is running. */
  private settle(bounty: BountyView): void {
    const waiting = this.subsOf(bounty.id).filter((s) => s.status === "waiting");
    if (waiting.length === 0) return;
    const winnerId = this.winners.get(bounty.id);
    const winner = waiting.find((s) => s.id === winnerId) ?? waiting[0]!;
    winner.state = "CREATOR_ACCEPTED";
    winner.status = "running";
    this.addReceipt(winner, "CreatorAcceptance", true, this.nowSec());
    this.emit(bounty.id, { type: "submission", submission: { ...winner } });
  }

  /** The contract releases USDC to the accepted submission and closes the rest. */
  private payout(sub: SubmissionView): void {
    const bounty = this.bounties.get(sub.bountyId)!;
    sub.state = "PAYOUT";
    sub.status = "paid";
    sub.payoutTx = mockHash(`payout:${sub.id}`);
    bounty.state = "AWARDED";
    this.emit(bounty.id, { type: "submission", submission: { ...sub } });
    for (const other of this.subsOf(bounty.id)) {
      if (other.status !== "waiting" && other.status !== "running") continue;
      other.status = "closed";
      this.emit(bounty.id, { type: "submission", submission: { ...other } });
    }
    this.emit(bounty.id, { type: "bounty", bounty: this.withCount(bounty) });
  }

  private addReceipt(sub: SubmissionView, receiptType: ReceiptType, result: boolean, timestamp: number): ReceiptView {
    const seed = `${sub.id}:${receiptType}:${result}`;
    const receipt: ReceiptView = {
      bountyId: sub.bountyId,
      submissionId: sub.id,
      commitHash: sub.commitHash,
      receiptType,
      runnerVersion: RUNNER_VERSION,
      result,
      timestamp,
      expiry: timestamp + 3600,
      digest: mockHash(`digest:${seed}`),
      signature: mockSignature(seed),
      signer: receiptType === "CreatorAcceptance" ? this.bounties.get(sub.bountyId)!.creator : RUNNER_SIGNER,
    };
    const list = this.receipts.get(sub.id) ?? [];
    list.push(receipt);
    this.receipts.set(sub.id, list);
    this.emit(sub.bountyId, { type: "receipt", receipt: { ...receipt } });
    return receipt;
  }

  private emit(bountyId: string, event: BountyEvent): void {
    for (const l of this.listeners) if (l.bountyId === bountyId) l.fn(event);
  }

  private subsOf(bountyId: string): SubmissionView[] {
    return [...this.subs.values()].filter((s) => s.bountyId === bountyId);
  }

  private withCount(b: BountyView): BountyView {
    return { ...b, submissionCount: this.subsOf(b.id).length };
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  // -------------------------------------------------------------------------
  // Demo data

  private seed(): void {
    const now = this.nowSec();
    const H = 3600;
    const D = 86_400;
    const creators: Hex[] = [
      "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db",
      "0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB",
    ];

    const bounty = (
      id: string,
      title: string,
      usdc: number,
      deadline: number,
      state: BountyView["state"],
      extra: Partial<BountyView>,
    ): void => {
      this.bounties.set(id, {
        id,
        title,
        amountUsdc: String(usdc * 1_000_000),
        deadline,
        state,
        creator: creators[Number(id.slice(-1)) % 2]!,
        specHash: mockHash(`spec:${id}`),
        testSuiteHash: mockHash(`tests:${id}`),
        allowNetwork: false,
        ...extra,
      });
    };

    /**
     * Adds a submission that has reached `state` with `status`, backfilling
     * receipts for every verified step (plus a failed one if rejected).
     */
    const submission = (
      id: string,
      bountyId: string,
      agentId: string,
      state: WorkflowState,
      status: SubmissionView["status"],
      createdAt: number,
      plan: Plan = {},
    ): void => {
      const sub: SubmissionView = {
        id,
        bountyId,
        agentId,
        commitHash: mockCommit(id),
        state: "CODE_SUBMITTED",
        status: "running",
        createdAt,
      };
      this.subs.set(id, sub);
      let t = createdAt;
      while (sub.state !== state) {
        const next = nextState(sub.state)!;
        t += 40 + (id.length * 7) % 30;
        sub.state = next;
        const type = RECEIPT_FOR[next];
        if (type) this.addReceipt(sub, type, true, t);
      }
      sub.status = status;
      if (status === "rejected") {
        sub.reason = plan.reason;
        const failed = nextState(state);
        const type = failed && RECEIPT_FOR[failed];
        if (type) this.addReceipt(sub, type, false, t + 35);
      }
      if (status === "paid") sub.payoutTx = mockHash(`payout:${id}`);
      this.plans.set(id, plan);
    };

    bounty("b-101", "Token-bucket rate limiter middleware for Express", 250, now + 2 * D + 5 * H, "OPEN", {
      summary: "Per-IP and per-key limits, Redis-free, with Retry-After headers.",
      repo: "github.com/abm-demo/express-ratelimit",
      testCommand: "pnpm test",
    });
    submission("s-101a", "b-101", "fast-careless", "CODE_SUBMITTED", "running", now - 14 * 60, {
      failAt: "TESTS_VERIFIED",
      reason: "4 of 18 tests failed",
    });
    submission("s-101b", "b-101", "test-focused", "BUILD_VERIFIED", "running", now - 11 * 60 - 20);
    submission("s-101c", "b-101", "security-focused", "TESTS_VERIFIED", "running", now - 9 * 60);
    this.winners.set("b-101", "s-101b");

    bounty("b-102", "Fix CSV parser on quoted newlines", 80, now - 1 * D, "AWARDED", {
      summary: "Quoted fields containing \\n are split into two rows.",
      repo: "github.com/abm-demo/tiny-csv",
      testCommand: "npm test",
    });
    submission("s-102a", "b-102", "fast-careless", "TESTS_VERIFIED", "rejected", now - 3 * D, {
      reason: "shell injection in exec() call",
    });
    submission("s-102b", "b-102", "test-focused", "PAYOUT", "paid", now - 2 * D - 4 * H);

    bounty("b-103", "ERC-20 permit() support for MockUSDC", 400, now + 5 * D, "OPEN", {
      summary: "EIP-2612 permit with nonces and deadline checks.",
      repo: "github.com/abm-demo/mock-usdc",
      testCommand: "forge test",
    });
    submission("s-103a", "b-103", "security-focused", "SECURITY_REVIEWED", "waiting", now - 9 * H);
    submission("s-103b", "b-103", "fast-careless", "CODE_SUBMITTED", "rejected", now - 7 * H, {
      reason: "solc: undeclared identifier `nonces`",
    });

    bounty("b-104", "Progress bar with ETA for the uploader CLI", 50, now + 20 * H, "OPEN", {
      summary: "Render bytes sent, rate, and ETA; fall back to plain lines without a TTY.",
      repo: "github.com/abm-demo/uploader",
      testCommand: "pnpm vitest run",
    });

    bounty("b-105", "Cursor pagination for GET /bounties", 120, now - 4 * D, "REFUNDED", {
      summary: "Opaque cursors, stable order under inserts.",
      repo: "github.com/abm-demo/bounty-api",
      testCommand: "pnpm test",
    });
  }
}
