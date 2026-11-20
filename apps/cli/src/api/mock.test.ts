import { isValidTransition } from "@abm/shared";
import { describe, expect, it } from "vitest";
import { MockClient, RUNNER_SIGNER } from "./mock";
import { NotFoundError, type BountyEvent } from "./types";

const NOW = 1_763_500_000_000;
const client = () => new MockClient({ now: () => NOW, manual: true });

function drain(c: MockClient, bountyId: string, maxTicks = 20): BountyEvent[] {
  const events: BountyEvent[] = [];
  const unsub = c.subscribe(bountyId, (e) => events.push(e));
  for (let i = 0; i < maxTicks; i++) c.tick();
  unsub();
  return events;
}

describe("MockClient data", () => {
  it("lists bounties with submission counts", async () => {
    const bounties = await client().listBounties();
    expect(bounties.map((b) => b.id)).toEqual(["b-101", "b-102", "b-103", "b-104", "b-105"]);
    expect(bounties.find((b) => b.id === "b-101")?.submissionCount).toBe(3);
    expect(new Set(bounties.map((b) => b.state))).toEqual(new Set(["OPEN", "AWARDED", "REFUNDED"]));
  });

  it("throws NotFoundError for unknown ids", async () => {
    await expect(client().getBounty("b-999")).rejects.toBeInstanceOf(NotFoundError);
    await expect(client().getReceipts("s-nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("backfills receipts bound to the submission commit", async () => {
    const c = client();
    const [sub] = (await c.listSubmissions("b-102")).filter((s) => s.id === "s-102b");
    const receipts = await c.getReceipts("s-102b");
    expect(receipts.map((r) => r.receiptType)).toEqual([
      "BuildReceipt",
      "TestReceipt",
      "SecurityReviewReceipt",
      "CreatorAcceptance",
    ]);
    expect(receipts.every((r) => r.commitHash === sub!.commitHash && r.result)).toBe(true);
    expect(receipts[0]!.signer).toBe(RUNNER_SIGNER);
    expect(receipts[0]!.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(sub!.payoutTx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("records a failing receipt for rejected submissions", async () => {
    const receipts = await client().getReceipts("s-102a");
    expect(receipts.at(-1)).toMatchObject({ receiptType: "SecurityReviewReceipt", result: false });
  });

  it("is deterministic", async () => {
    expect(await client().getReceipts("s-103a")).toEqual(await client().getReceipts("s-103a"));
  });
});

describe("MockClient simulation", () => {
  it("only moves submissions through valid transitions", () => {
    const c = client();
    const last = new Map<string, string>();
    for (const e of drain(c, "b-101")) {
      if (e.type !== "submission") continue;
      const prev = last.get(e.submission.id);
      if (prev && prev !== e.submission.state) {
        expect(isValidTransition(prev as never, e.submission.state)).toBe(true);
      }
      last.set(e.submission.id, e.submission.state);
    }
  });

  it("settles b-101: one rejected, the planned winner paid, the rest closed", async () => {
    const c = client();
    drain(c, "b-101");
    const subs = await c.listSubmissions("b-101");
    const byId = Object.fromEntries(subs.map((s) => [s.id, s]));
    expect(byId["s-101a"]).toMatchObject({ status: "rejected", state: "BUILD_VERIFIED", reason: "4 of 18 tests failed" });
    expect(byId["s-101b"]).toMatchObject({ status: "paid", state: "PAYOUT" });
    expect(byId["s-101c"]).toMatchObject({ status: "closed", state: "SECURITY_REVIEWED" });
    expect((await c.getBounty("b-101")).state).toBe("AWARDED");
  });

  it("does not accept while anything is still running", () => {
    const c = client();
    const events = drain(c, "b-101");
    const acceptIdx = events.findIndex((e) => e.type === "receipt" && e.receipt.receiptType === "CreatorAcceptance");
    const rejectIdx = events.findIndex((e) => e.type === "submission" && e.submission.status === "rejected");
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(acceptIdx).toBeGreaterThan(rejectIdx);
  });

  it("only emits events for the subscribed bounty", () => {
    const events = drain(client(), "b-103");
    const ids = new Set(events.map((e) => (e.type === "bounty" ? e.bounty.id : e.type === "submission" ? e.submission.bountyId : e.receipt.bountyId)));
    expect([...ids]).toEqual(["b-103"]);
  });

  it("runs a new submission end to end", async () => {
    const c = client();
    const sub = await c.submit({ bountyId: "b-104", agentId: "test-focused", commitHash: "a".repeat(40) });
    expect(sub).toMatchObject({ state: "CODE_SUBMITTED", status: "running" });
    drain(c, "b-104");
    const [done] = await c.listSubmissions("b-104");
    expect(done).toMatchObject({ status: "paid", state: "PAYOUT" });
    expect((await c.getReceipts(sub.id)).map((r) => r.receiptType)).toHaveLength(4);
  });

  it("rejects the careless agent at tests", async () => {
    const c = client();
    const sub = await c.submit({ bountyId: "b-104", agentId: "fast-careless", commitHash: "b".repeat(40) });
    drain(c, "b-104");
    const [done] = await c.listSubmissions("b-104");
    expect(done).toMatchObject({ id: sub.id, status: "rejected", state: "BUILD_VERIFIED" });
  });

  it("refuses submissions to closed bounties", async () => {
    await expect(client().submit({ bountyId: "b-102", agentId: "x", commitHash: "c" })).rejects.toThrow(/awarded/);
  });
});
