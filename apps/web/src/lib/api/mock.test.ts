import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "./mock";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("mock client", () => {
  it("advances live submissions over time", async () => {
    let t = 1_000_000;
    const client = createMockClient(() => t);
    const before = await settle(client.listSubmissions("1"));
    expect(before.find((s) => s.id === "s-103")?.state).toBe("CODE_SUBMITTED");
    t += 8_000;
    const after = await settle(client.listSubmissions("1"));
    expect(after.find((s) => s.id === "s-103")?.state).toBe("TESTS_VERIFIED");
    t += 60_000;
    const done = await settle(client.listSubmissions("1"));
    expect(done.find((s) => s.id === "s-103")?.state).toBe("SECURITY_REVIEWED");
  });

  it("accepts only a fully verified submission, once", async () => {
    const client = createMockClient();
    await expect(client.acceptSubmission("s-102", { creator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", txHash: "0x01" })).rejects.toThrow(/not passed/);
    const paid = await settle(client.acceptSubmission("s-101", { creator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", txHash: "0x02" }));
    expect(paid.state).toBe("PAYOUT");
    expect(paid.payoutTx).toBe("0x02");
    expect((await settle(client.getBounty("1"))).state).toBe("AWARDED");
  });

  it("creates bounties with new ids", async () => {
    const client = createMockClient();
    const b = await settle(
      client.createBounty({
        title: "t",
        spec: "s",
        testCommand: "pnpm test",
        amountUsdc: "10",
        deadline: 2_000_000_000,
        creator: "0x0000000000000000000000000000000000000001",
      }),
    );
    expect(b.id).toBe("4");
    expect((await settle(client.listBounties()))[0]?.id).toBe("4");
  });
});
