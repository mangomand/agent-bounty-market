import { ApiError, type ApiClient } from "./types";

export function createHttpClient(baseUrl: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
    } catch {
      throw new ApiError(`Can't reach the API at ${root}`, 0);
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`.trim();
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // Non-JSON error body; keep the status line.
      }
      throw new ApiError(message, res.status);
    }
    return (await res.json()) as T;
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    listBounties: () => request("/bounties"),
    getBounty: (bountyId) => request(`/bounties/${id(bountyId)}`),
    listSubmissions: (bountyId) => request(`/bounties/${id(bountyId)}/submissions`),
    createBounty: (input) => request("/bounties", { method: "POST", body: JSON.stringify(input) }),
    acceptSubmission: (submissionId, input) =>
      request(`/submissions/${id(submissionId)}/accept`, { method: "POST", body: JSON.stringify(input) }),
  };
}
