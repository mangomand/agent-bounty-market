import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http";
import { ApiError } from "./types";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("http client", () => {
  it("calls the documented routes", async () => {
    const f = fakeFetch(200, {});
    const client = createHttpClient("http://api.test/", f as unknown as typeof fetch);
    await client.listBounties();
    await client.getBounty("a/b");
    await client.listSubmissions("1");
    await client.acceptSubmission("s-1", { txHash: "0x01" });
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "http://api.test/bounties",
      "http://api.test/bounties/a%2Fb",
      "http://api.test/bounties/1/submissions",
      "http://api.test/submissions/s-1/accept",
    ]);
    expect(calls[3]?.[1].method).toBe("POST");
    expect(calls[3]?.[1].body).toBe(JSON.stringify({ txHash: "0x01" }));
  });

  it("surfaces the API error message", async () => {
    const client = createHttpClient("http://api.test", fakeFetch(409, { error: "Already settled" }) as unknown as typeof fetch);
    await expect(client.getBounty("1")).rejects.toEqual(new ApiError("Already settled", 409));
  });

  it("reports an unreachable API", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createHttpClient("http://api.test", f as unknown as typeof fetch);
    await expect(client.listBounties()).rejects.toThrow("Can't reach the API");
  });
});
