import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiClientError, httpApi, type BountyApi } from "./api-client";
import { createServer } from "./server";
import { callTool, TOOL_NAMES } from "./tools";

const COMMIT = "a".repeat(40);

function fakeApi(): BountyApi & { [K in keyof BountyApi]: ReturnType<typeof vi.fn> } {
  return {
    listBounties: vi.fn(async () => []),
    getBounty: vi.fn(async () => {
      throw new ApiClientError(404, "not_found", "bounty bty_x not found");
    }),
    getRepository: vi.fn(async (id: string) => ({ bountyId: id, repoUrl: null, repoRef: null, testCommand: "npm test", allowNetwork: false })),
    createSubmission: vi.fn(async (bountyId: string) => ({ id: "sub_1", bountyId })),
    getSubmission: vi.fn(async () => ({})),
    requestRun: vi.fn(async (submissionId: string, kind: string) => ({ id: "run_1", submissionId, kind })),
  } as never;
}

async function connect(api: BountyApi) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(api).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("tool list", () => {
  it("exposes exactly the allowed tools", async () => {
    const client = await connect(fakeApi());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("contains no tools that move funds, modify bounties, or touch keys", async () => {
    const client = await connect(fakeApi());
    const { tools } = await client.listTools();
    const forbidden = /accept|approve|withdraw|refund|payout|pay|transfer|send|sign|key|wallet|fund|transaction|tx|create_bounty|update|delete|modify|cancel|receipt/i;
    for (const t of tools) expect(t.name).not.toMatch(forbidden);
  });
});

describe("input validation", () => {
  const bad: [string, unknown][] = [
    ["get_bounty_spec", {}],
    ["get_bounty_spec", { bountyId: "../../admin" }],
    ["get_bounty_spec", { bountyId: "bty_ok", extra: 1 }],
    ["download_repository", { bountyId: 42 }],
    ["list_bounties", { state: "ALL" }],
    ["get_submission_status", { submissionId: "bty_wrongprefix" }],
    ["request_test_run", { submissionId: "sub_1; rm -rf /" }],
    ["request_security_review", { submissionId: "" }],
    ["submit_code", { bountyId: "bty_ok", agentId: "a", commitHash: "HEAD", repoUrl: "https://g.com/r" }],
    ["submit_code", { bountyId: "bty_ok", agentId: "a", commitHash: COMMIT, repoUrl: "http://g.com/r" }],
    ["submit_code", { bountyId: "bty_ok", agentId: "a", commitHash: COMMIT }],
    ["submit_code", { bountyId: "bty_ok", agentId: "a", commitHash: COMMIT, repoUrl: "https://g.com/r", sourceTarballBase64: "aGk=" }],
    ["submit_code", { bountyId: "bty_ok", agentId: "a/../b", commitHash: COMMIT, repoUrl: "https://g.com/r" }],
  ];

  it.each(bad)("%s rejects %j", async (name, args) => {
    const api = fakeApi();
    const r = await callTool(api, name, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/invalid input/);
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects unknown tools", async () => {
    const r = await callTool(fakeApi(), "accept_submission", { submissionId: "sub_1" });
    expect(r.isError).toBe(true);
  });

  it("rejects invalid input over the MCP protocol", async () => {
    const api = fakeApi();
    const client = await connect(api);
    const r = (await client.callTool({ name: "request_test_run", arguments: { submissionId: "nope" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(api.requestRun).not.toHaveBeenCalled();
  });
});

describe("tool calls", () => {
  it("submit_code forwards a valid submission", async () => {
    const api = fakeApi();
    const client = await connect(api);
    const r = (await client.callTool({
      name: "submit_code",
      arguments: { bountyId: "bty_demo1", agentId: "fast-agent", commitHash: COMMIT, repoUrl: "https://github.com/x/y" },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(api.createSubmission).toHaveBeenCalledWith("bty_demo1", { agentId: "fast-agent", commitHash: COMMIT, repoUrl: "https://github.com/x/y" });
    expect(JSON.parse(text(r))).toMatchObject({ id: "sub_1" });
  });

  it("maps run requests to the right kind", async () => {
    const api = fakeApi();
    await callTool(api, "request_test_run", { submissionId: "sub_1" });
    await callTool(api, "request_security_review", { submissionId: "sub_1" });
    expect(api.requestRun.mock.calls).toEqual([["sub_1", "test"], ["sub_1", "security"]]);
  });

  it("list_bounties defaults to OPEN", async () => {
    const api = fakeApi();
    await callTool(api, "list_bounties", {});
    expect(api.listBounties).toHaveBeenCalledWith("OPEN");
  });

  it("surfaces API errors as tool errors", async () => {
    const r = await callTool(fakeApi(), "get_bounty_spec", { bountyId: "bty_x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("not_found: bounty bty_x not found");
  });
});

describe("http client", () => {
  it("calls the expected routes", async () => {
    const calls: [string, string][] = [];
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url.pathname + url.search]);
      return new Response(JSON.stringify({ bounties: [], bounty: {}, repository: {}, submission: {}, run: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = httpApi("http://127.0.0.1:4000", fetchImpl);
    await api.listBounties("OPEN");
    await api.getRepository("bty_a");
    await api.createSubmission("bty_a", { agentId: "x", commitHash: COMMIT, repoUrl: "https://g.com/r" });
    await api.requestRun("sub_a", "test");
    expect(calls).toEqual([
      ["GET", "/bounties?state=OPEN"],
      ["GET", "/bounties/bty_a/repository"],
      ["POST", "/bounties/bty_a/submissions"],
      ["POST", "/submissions/sub_a/runs"],
    ]);
  });
});
