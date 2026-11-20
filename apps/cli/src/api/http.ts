import {
  NotFoundError,
  type BountyClient,
  type BountyEvent,
  type BountyView,
  type ReceiptView,
  type SubmissionView,
} from "./types";

/**
 * Thin client for the local API (apps/api). Every route the CLI depends on is
 * listed here so it is easy to align with the API once it lands:
 *
 *   GET  /bounties                      → BountyView[]
 *   GET  /bounties/:id                  → BountyView
 *   GET  /bounties/:id/submissions      → SubmissionView[]
 *   GET  /submissions/:id/receipts      → ReceiptView[]
 *   GET  /events?bountyId=:id           → SSE, each `data:` line is a BountyEvent JSON
 *   POST /bounties/:id/submissions      → SubmissionView   (demo agents only; provisional)
 */
export class HttpClient implements BountyClient {
  readonly source: string;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.source = this.baseUrl;
  }

  listBounties(): Promise<BountyView[]> {
    return this.get("/bounties");
  }

  getBounty(id: string): Promise<BountyView> {
    return this.get(`/bounties/${encodeURIComponent(id)}`);
  }

  listSubmissions(bountyId: string): Promise<SubmissionView[]> {
    return this.get(`/bounties/${encodeURIComponent(bountyId)}/submissions`);
  }

  getReceipts(submissionId: string): Promise<ReceiptView[]> {
    return this.get(`/submissions/${encodeURIComponent(submissionId)}/receipts`);
  }

  submit(input: { bountyId: string; agentId: string; commitHash: string }): Promise<SubmissionView> {
    return this.request(`/bounties/${encodeURIComponent(input.bountyId)}/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: input.agentId, commitHash: input.commitHash }),
    });
  }

  subscribe(bountyId: string, onEvent: (e: BountyEvent) => void, onError?: (err: Error) => void): () => void {
    const ctrl = new AbortController();
    const url = `${this.baseUrl}/events?bountyId=${encodeURIComponent(bountyId)}`;
    (async () => {
      const res = await this.fetchImpl(url, { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`GET /events failed: HTTP ${res.status}`);
      for await (const data of readSse(res.body)) {
        try {
          onEvent(JSON.parse(data) as BountyEvent);
        } catch {
          // Ignore malformed frames rather than killing the stream.
        }
      }
      throw new Error("Event stream closed by the API");
    })().catch((err: unknown) => {
      if (ctrl.signal.aborted) return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    return () => ctrl.abort();
  }

  private get<T>(path: string): Promise<T> {
    return this.request(path, { headers: { accept: "application/json" } });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, init);
    } catch {
      throw new Error(`No API at ${this.baseUrl}. Run \`corepack pnpm dev\` or use --mock.`);
    }
    if (res.status === 404) throw new NotFoundError(`Not found: ${path}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${init.method ?? "GET"} ${path} failed: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as T;
  }
}

/** Yields the `data` payload of each server-sent event. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
