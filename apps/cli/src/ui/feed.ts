import { useEffect, useState } from "react";
import type { BountyClient, BountyEvent, BountyView, SubmissionView } from "../api/types";
import { formatUsdc, RECEIPT_LABEL, shortHash } from "../format";
import type { Tone } from "./components";

export interface LogEntry {
  key: number;
  time: number;
  subId: string;
  text: string;
  tone: Tone;
}

export interface Feed {
  bounty?: BountyView;
  subs: SubmissionView[];
  log: LogEntry[];
  error?: Error;
}

const MAX_LOG = 6;
let logKey = 0;

/** Turns a raw event into a log line, or null if it isn't worth showing. */
export function describeEvent(e: BountyEvent, prev: Feed): Omit<LogEntry, "key"> | null {
  if (e.type === "receipt") {
    const r = e.receipt;
    const label = RECEIPT_LABEL[r.receiptType];
    if (r.receiptType === "CreatorAcceptance")
      return { time: r.timestamp, subId: r.submissionId, text: `accepted by creator · ${shortHash(r.digest)}`, tone: "ok" };
    return {
      time: r.timestamp,
      subId: r.submissionId,
      text: `${label} ${r.result ? "verified" : "failed"} · receipt ${shortHash(r.digest)}`,
      tone: r.result ? "ok" : "bad",
    };
  }
  if (e.type === "submission") {
    const s = e.submission;
    const before = prev.subs.find((x) => x.id === s.id);
    const now = Math.floor(Date.now() / 1000);
    if (!before) return { time: s.createdAt, subId: s.id, text: `submitted by ${s.agentId}`, tone: "plain" };
    if (s.status === "paid" && before.status !== "paid") {
      const amount = prev.bounty ? `${formatUsdc(prev.bounty.amountUsdc)} ` : "";
      return { time: now, subId: s.id, text: `paid ${amount}· tx ${s.payoutTx ? shortHash(s.payoutTx) : "?"}`, tone: "ok" };
    }
    if (s.status === "rejected" && before.status !== "rejected")
      return { time: now, subId: s.id, text: `rejected${s.reason ? `: ${s.reason}` : ""}`, tone: "bad" };
  }
  return null;
}

export function applyEvent(feed: Feed, e: BountyEvent): Feed {
  const entry = describeEvent(e, feed);
  const log = entry ? [...feed.log, { ...entry, key: ++logKey }].slice(-MAX_LOG) : feed.log;
  if (e.type === "bounty") return { ...feed, bounty: e.bounty, log };
  if (e.type === "submission") {
    const exists = feed.subs.some((s) => s.id === e.submission.id);
    const subs = exists
      ? feed.subs.map((s) => (s.id === e.submission.id ? e.submission : s))
      : [...feed.subs, e.submission];
    return { ...feed, subs, log };
  }
  return { ...feed, log };
}

/** True once nothing more will happen without outside action. */
export function isSettled(feed: Feed): boolean {
  if (!feed.bounty) return false;
  if (feed.subs.some((s) => s.status === "running")) return false;
  return feed.bounty.state !== "OPEN";
}

/** Initial load plus live events for one bounty. */
export function useBountyFeed(client: BountyClient, bountyId: string): Feed {
  const [feed, setFeed] = useState<Feed>({ subs: [], log: [] });
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let live = true;
    const fail = (err: unknown) =>
      live && setFeed((f) => ({ ...f, error: err instanceof Error ? err : new Error(String(err)) }));
    Promise.all([client.getBounty(bountyId), client.listSubmissions(bountyId)]).then(([bounty, subs]) => {
      if (!live) return;
      setFeed((f) => ({ ...f, bounty, subs: [...subs].sort((a, b) => a.createdAt - b.createdAt) }));
      unsub = client.subscribe(bountyId, (e) => live && setFeed((f) => applyEvent(f, e)), fail);
    }, fail);
    return () => {
      live = false;
      unsub?.();
    };
  }, [client, bountyId]);
  return feed;
}
