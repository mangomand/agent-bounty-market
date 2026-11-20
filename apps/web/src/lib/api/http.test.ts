import type { ApiBounty, ApiSubmission } from "@abm/shared";
import { keccak256, toBytes } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createHttpClient, toSubmissionView } from "./http";
import { ApiError } from "./types";

const H = (c: string) => `0x${c.repeat(64)}` as const;
const bounty: ApiBounty = {
  id: "bty_1", title: "T", description: "", spec: "spec", specHash: H("1"), testSuiteHash: H("2"), amountUsdc: "50",
  creator: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", deadline: 2_000_000_000, state: "OPEN", repoUrl: null, repoRef: null,
  testCommand: "npm test", allowNetwork: false, onchainId: "1", fundTxHash: H("f"), acceptedSubmissionId: null,
  payoutTxHash: null, createdAt: 1, submissionCount: 0,
};
const sub: ApiSubmission = {
  id: "sub_1", bountyId: "bty_1", agentId: "a", commitHash: "a".repeat(40), state: "BUILD_VERIFIED", createdAt: 1, updatedAt: 1,
  source: { kind: "tarball", bytes: 10 }, checks: { build: "passed", test: "failed", security: "pending" },
  payoutAddress: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65", onchainId: "3", submitTxHash: H("3"), acceptTxHash: null,
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("http client", () => {
  it("calls the API routes and unwraps responses", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      const list = url.endsWith("/bounties") && init?.method !== "POST";
      const body = url.endsWith("/submissions") ? { submissions: [sub] } : list ? { bounties: [bounty] } : url.endsWith("/accept") ? { submission: sub } : { bounty };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = createHttpClient("http://api.test/", f as unknown as typeof fetch);
    expect((await client.listBounties())[0]).toMatchObject({ id: "bty_1", onchainId: "1", fundTx: H("f") });
    await client.getBounty("a/b");
    expect((await client.listSubmissions("bty_1"))[0]).toMatchObject({ onchainId: "3" });
    await client.recordFunding("bty_1", H("f"));
    await client.acceptSubmission("sub_1", { creator: bounty.creator, txHash: H("e") });
    await client.createBounty({ title: "T", spec: "spec", testCommand: "npm test", amountUsdc: "5", deadline: 2_000_000_000, creator: bounty.creator });
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method ?? "GET"} ${url}`)).toEqual([
      "GET http://api.test/bounties",
      "GET http://api.test/bounties/a%2Fb",
      "GET http://api.test/bounties/bty_1/submissions",
      "POST http://api.test/bounties/bty_1/fund",
      "POST http://api.test/submissions/sub_1/accept",
      "POST http://api.test/bounties",
    ]);
    expect(JSON.parse(String(calls[4]?.[1].body))).toEqual({ creator: bounty.creator, txHash: H("e") });
    expect(JSON.parse(String(calls[5]?.[1].body))).toMatchObject({ specHash: keccak256(toBytes("spec")) });
  });

  it("maps a failed check to a rejection", () => {
    expect(toSubmissionView(sub).failure).toEqual({ state: "TESTS_VERIFIED", reason: "Tests failed" });
  });

  it("surfaces the API error message", async () => {
    const client = createHttpClient(
      "http://api.test",
      fakeFetch(409, { error: { code: "bounty_closed", message: "bounty is AWARDED" } }) as unknown as typeof fetch,
    );
    await expect(client.getBounty("1")).rejects.toEqual(new ApiError("bounty is AWARDED", 409));
  });

  it("reports an unreachable API", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createHttpClient("http://api.test", f as unknown as typeof fetch);
    await expect(client.listBounties()).rejects.toThrow("Can't reach the API");
  });
});
