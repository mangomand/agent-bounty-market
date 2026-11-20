import type {
  ApiBounty,
  ApiReceipt,
  ApiRun,
  ApiSubmission,
  CreateSubmissionRequest,
  RepositoryInfo,
  RunKind,
} from "@abm/shared";

export class ApiClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** The subset of the local API the MCP server is allowed to call. No accept, no bounty writes. */
export interface BountyApi {
  listBounties(state?: ApiBounty["state"]): Promise<ApiBounty[]>;
  getBounty(id: string): Promise<ApiBounty>;
  getRepository(id: string): Promise<RepositoryInfo>;
  createSubmission(bountyId: string, body: CreateSubmissionRequest): Promise<ApiSubmission>;
  getSubmission(id: string): Promise<{ submission: ApiSubmission; runs: ApiRun[] }>;
  getReceipts(submissionId: string): Promise<ApiReceipt[]>;
  requestRun(submissionId: string, kind: RunKind): Promise<ApiRun>;
}

export function httpApi(baseUrl: string, fetchImpl: typeof fetch = fetch): BountyApi {
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!res.ok) throw new ApiClientError(res.status, json.error?.code ?? "http_error", json.error?.message ?? `API returned ${res.status}`);
    return json as T;
  };
  // Ids are validated by the tool schemas before reaching here; encode anyway.
  const e = encodeURIComponent;
  return {
    listBounties: async (state) =>
      (await call<{ bounties: ApiBounty[] }>("GET", state ? `/bounties?state=${e(state)}` : "/bounties")).bounties,
    getBounty: async (id) => (await call<{ bounty: ApiBounty }>("GET", `/bounties/${e(id)}`)).bounty,
    getRepository: async (id) => (await call<{ repository: RepositoryInfo }>("GET", `/bounties/${e(id)}/repository`)).repository,
    createSubmission: async (bountyId, body) =>
      (await call<{ submission: ApiSubmission }>("POST", `/bounties/${e(bountyId)}/submissions`, body)).submission,
    getSubmission: (id) => call("GET", `/submissions/${e(id)}`),
    getReceipts: async (id) => (await call<{ receipts: ApiReceipt[] }>("GET", `/submissions/${e(id)}/receipts`)).receipts,
    requestRun: async (id, kind) => (await call<{ run: ApiRun }>("POST", `/submissions/${e(id)}/runs`, { kind })).run,
  };
}
