import { Box, Text, useApp } from "ink";
import { useEffect } from "react";
import type { BountyClient, SubmissionView } from "../../api/types";
import { fit, formatClock, formatUsdc, shortHash, truncate } from "../../format";
import { BountyHeader, ErrorLine, Spin, SubmissionRow, T } from "../components";
import { isSettled, useBountyFeed, type Feed } from "../feed";

export function Summary({ subs }: { subs: SubmissionView[] }) {
  const count = (s: SubmissionView["status"]) => subs.filter((x) => x.status === s).length;
  return (
    <Text>
      {" "}
      <T tone="pending">{count("running")} running</T>
      <T tone="muted"> · </T>
      <T tone="pending">{count("waiting")} awaiting creator</T>
      <T tone="muted"> · </T>
      <T tone="bad">{count("rejected")} rejected</T>
      <T tone="muted"> · </T>
      <T tone="ok">{count("paid")} paid</T>
    </Text>
  );
}

export function FeedView({ feed, source, width, now, focus }: { feed: Feed; source: string; width: number; now?: number; focus?: string }) {
  const { bounty, subs, log } = feed;
  if (!bounty) return null;
  const shown = focus ? subs.filter((s) => s.id === focus) : subs;
  const paid = subs.find((s) => s.status === "paid");
  return (
    <Box flexDirection="column">
      <BountyHeader bounty={bounty} source={source} width={width} now={now} />
      <Text> </Text>
      {shown.length === 0 && <T tone="muted"> No submissions yet.</T>}
      {shown.map((s) => (
        <Box key={s.id} marginBottom={1}>
          <SubmissionRow sub={s} width={width} />
        </Box>
      ))}
      {log.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <T bold> Activity</T>
          {log.map((e) => (
            <Text key={e.key}>
              {" "}
              <T tone="muted">{formatClock(e.time)}</T> {fit(e.subId, 8)}{" "}
              <T tone={e.tone}>{truncate(e.text, width - 21)}</T>
            </Text>
          ))}
        </Box>
      )}
      {!focus && <Summary subs={subs} />}
      {paid?.payoutTx && (
        <Text>
          {" "}
          <T tone="ok">✓ Paid {formatUsdc(bounty.amountUsdc)}</T> to {paid.id} · tx {shortHash(paid.payoutTx, 10, 8)}
        </Text>
      )}
    </Box>
  );
}

export function WatchView({
  client,
  bountyId,
  width,
  now,
  exitWhenSettled = true,
}: {
  client: BountyClient;
  bountyId: string;
  width: number;
  now?: number;
  exitWhenSettled?: boolean;
}) {
  const { exit } = useApp();
  const feed = useBountyFeed(client, bountyId);
  const settled = isSettled(feed);

  useEffect(() => {
    if (feed.error) exit(feed.error);
  }, [feed.error, exit]);
  useEffect(() => {
    if (exitWhenSettled && settled) {
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
  }, [settled, exitWhenSettled, exit]);

  if (feed.error) return <ErrorLine message={feed.error.message} />;
  if (!feed.bounty)
    return (
      <Text>
        <Spin /> Connecting to {client.source}
      </Text>
    );
  return (
    <Box flexDirection="column">
      <FeedView feed={feed} source={client.source} width={width} now={now} />
      {!settled && <T tone="muted"> Watching live · Ctrl+C to stop</T>}
    </Box>
  );
}
