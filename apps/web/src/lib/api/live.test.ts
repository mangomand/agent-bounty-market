import type { ApiEvent } from "@abm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLive, eventsUrl, keyBatcher, queryKeysForEvent, type EventSourceLike } from "./live";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

describe("queryKeysForEvent", () => {
  it("refetches submissions on workflow progress", () => {
    expect(queryKeysForEvent({ type: "submission.updated", bountyId: "bty_1" })).toEqual([["submissions", "bty_1"]]);
    expect(queryKeysForEvent({ type: "receipt.created", bountyId: "bty_1" })).toEqual([["submissions", "bty_1"]]);
  });

  it("refreshes list counts when a submission or bounty changes", () => {
    expect(queryKeysForEvent({ type: "submission.created", bountyId: "bty_1" })).toContainEqual(["bounties"]);
    expect(queryKeysForEvent({ type: "bounty.updated", bountyId: "bty_1" })).toEqual([["bounty", "bty_1"], ["bounties"]]);
  });
});

describe("eventsUrl", () => {
  it("filters by bounty", () => {
    expect(eventsUrl("http://localhost:4000/", "bty_1")).toBe("http://localhost:4000/events?bountyId=bty_1");
    expect(eventsUrl("http://localhost:4000")).toBe("http://localhost:4000/events");
  });
});

describe("connectLive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sources: FakeSource[] = [];
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onStatus = vi.fn();
    const stop = connectLive({
      url: "http://api/events?bountyId=bty_1",
      onEvent,
      onReady,
      onStatus,
      retryMs: 100,
      maxRetryMs: 300,
      createSource: (url) => {
        const s = new FakeSource(url);
        sources.push(s);
        return s;
      },
    });
    return { sources, onEvent, onReady, onStatus, stop };
  }

  it("goes live on ready and forwards parsed events", () => {
    const { sources, onEvent, onReady, onStatus } = setup();
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    sources[0]!.emit("ready", { bountyId: "bty_1" });
    expect(onStatus).toHaveBeenLastCalledWith("live");
    expect(onReady).toHaveBeenCalledOnce();
    const e = { type: "submission.updated", bountyId: "bty_1", submission: { id: "sub_1" } } as unknown as ApiEvent;
    sources[0]!.emit("submission.updated", e);
    expect(onEvent).toHaveBeenCalledWith(e);
  });

  it("leaves transient drops to the browser", () => {
    const { sources, onStatus } = setup();
    sources[0]!.fail(0);
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    vi.advanceTimersByTime(1_000);
    expect(sources).toHaveLength(1);
  });

  it("reopens a closed stream with backoff and stops on cleanup", () => {
    const { sources, stop } = setup();
    sources[0]!.fail(2);
    vi.advanceTimersByTime(99);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    sources[1]!.fail(2);
    vi.advanceTimersByTime(200);
    expect(sources).toHaveLength(3);
    stop();
    expect(sources[2]!.closed).toBe(true);
    sources[2]!.fail(2);
    vi.advanceTimersByTime(1_000);
    expect(sources).toHaveLength(3);
  });
});

describe("keyBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushes each distinct key once per window", () => {
    const flush = vi.fn();
    const b = keyBatcher(flush, 100);
    b.add([["submissions", "bty_1"]]);
    b.add([["submissions", "bty_1"], ["bounties"]]);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(flush.mock.calls).toEqual([[["submissions", "bty_1"]], [["bounties"]]]);
    b.add([["bounties"]]);
    b.cancel();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
