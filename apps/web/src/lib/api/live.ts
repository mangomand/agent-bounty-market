import type { ApiEvent, ApiEventType } from "@abm/shared";

/** Event names the API sends on `GET /events`. `ready` and `ping` carry no state. */
export const LIVE_EVENT_TYPES: readonly ApiEventType[] = [
  "bounty.created",
  "bounty.updated",
  "submission.created",
  "submission.updated",
  "receipt.created",
  "run.started",
  "run.finished",
];

/** React Query keys to refetch after an event. Matches the keys used by the pages. */
export function queryKeysForEvent(e: Pick<ApiEvent, "type" | "bountyId">): unknown[][] {
  switch (e.type) {
    case "bounty.created":
      return [["bounties"]];
    case "bounty.updated":
      return [["bounty", e.bountyId], ["bounties"]];
    case "submission.created":
      return [["submissions", e.bountyId], ["bounty", e.bountyId], ["bounties"]];
    case "submission.updated":
    case "receipt.created":
    case "run.started":
    case "run.finished":
      return [["submissions", e.bountyId]];
  }
}

export type LiveStatus = "connecting" | "live";

/** The subset of `EventSource` used here, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export interface LiveOptions {
  url: string;
  onEvent: (e: ApiEvent) => void;
  /** Called on every (re)connect, so callers can refetch anything missed while offline. */
  onReady: () => void;
  onStatus: (s: LiveStatus) => void;
  createSource?: (url: string) => EventSourceLike;
  /** Delay before reopening a closed stream; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

const CLOSED = 2;

/**
 * Subscribes to the API's SSE stream and reopens it when the browser gives up
 * (EventSource retries transient drops by itself, but not a failed response).
 * Returns a function that closes the stream.
 */
export function connectLive(opts: LiveOptions): () => void {
  const create = opts.createSource ?? ((url) => new EventSource(url));
  const baseRetry = opts.retryMs ?? 1_000;
  const maxRetry = opts.maxRetryMs ?? 10_000;
  let retry = baseRetry;
  let source: EventSourceLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    opts.onStatus("connecting");
    const s = create(opts.url);
    source = s;
    s.addEventListener("ready", () => {
      retry = baseRetry;
      opts.onStatus("live");
      opts.onReady();
    });
    for (const type of LIVE_EVENT_TYPES) {
      s.addEventListener(type, (ev) => {
        let data: ApiEvent;
        try {
          data = JSON.parse(ev.data) as ApiEvent;
        } catch {
          return;
        }
        opts.onEvent(data);
      });
    }
    s.onerror = () => {
      if (stopped) return;
      opts.onStatus("connecting");
      if (s.readyState !== CLOSED) return; // The browser is already retrying.
      s.close();
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, maxRetry);
    };
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}

export function eventsUrl(apiUrl: string, bountyId?: string): string {
  const root = apiUrl.replace(/\/+$/, "");
  return bountyId ? `${root}/events?bountyId=${encodeURIComponent(bountyId)}` : `${root}/events`;
}

/**
 * Collects query keys and flushes each distinct key once per `ms`, so a burst of
 * events (a run finishing emits several) causes one refetch instead of several.
 */
export function keyBatcher(flush: (key: unknown[]) => void, ms = 100) {
  const pending = new Map<string, unknown[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    add(keys: unknown[][]) {
      for (const k of keys) pending.set(JSON.stringify(k), k);
      timer ??= setTimeout(() => {
        timer = undefined;
        const keys = [...pending.values()];
        pending.clear();
        for (const k of keys) flush(k);
      }, ms);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
