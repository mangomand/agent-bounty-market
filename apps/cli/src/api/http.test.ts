import { describe, expect, it, vi } from "vitest";
import { HttpClient, readSse } from "./http";
import { NotFoundError, type BountyEvent } from "./types";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
}

describe("readSse", () => {
  it("joins frames split across chunks and skips comments", async () => {
    const out: string[] = [];
    for await (const d of readSse(streamOf([": hi\n\n", 'data: {"a"', ":1}\n\nevent: x\r\ndata: 2\r\n\r\n"]))) out.push(d);
    expect(out).toEqual(['{"a":1}', "2"]);
  });
});

describe("HttpClient", () => {
  it("hits the documented routes", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    const c = new HttpClient("http://api.test/", fetchMock as unknown as typeof fetch);
    await c.listBounties();
    await c.listSubmissions("b 1");
    await c.getReceipts("s-1");
    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "http://api.test/bounties",
      "http://api.test/bounties/b%201/submissions",
      "http://api.test/submissions/s-1/receipts",
    ]);
  });

  it("maps 404 to NotFoundError and network failure to a hint", async () => {
    const notFound = new HttpClient("http://x", (async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    await expect(notFound.getBounty("b-9")).rejects.toBeInstanceOf(NotFoundError);
    const down = new HttpClient("http://x", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(down.listBounties()).rejects.toThrow(/--mock/);
  });

  it("streams events from /events", async () => {
    const event: BountyEvent = {
      type: "submission",
      submission: { id: "s-1", bountyId: "b-1", agentId: "a", commitHash: "c", state: "CODE_SUBMITTED", status: "running", createdAt: 1 },
    };
    const fetchMock = vi.fn(async () => new Response(streamOf([`data: ${JSON.stringify(event)}\n\n`]), { status: 200 }));
    const c = new HttpClient("http://x", fetchMock as unknown as typeof fetch);
    const got = await new Promise<BountyEvent>((resolve) => c.subscribe("b-1", resolve));
    expect(got).toEqual(event);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://x/events?bountyId=b-1");
  });
});
