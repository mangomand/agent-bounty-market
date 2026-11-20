import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import type { CodingAgent } from "../../agents";
import type { BountyClient, SubmissionView } from "../../api/types";
import { shortCommit } from "../../format";
import { ErrorLine, Spin, T } from "../components";
import { useBountyFeed } from "../feed";
import { FeedView } from "./Watch";

type Phase = { kind: "agent" } | { kind: "submitted"; sub: SubmissionView } | { kind: "error"; error: Error };

function Live({ client, bountyId, sub, width, now }: { client: BountyClient; bountyId: string; sub: SubmissionView; width: number; now?: number }) {
  const { exit } = useApp();
  const feed = useBountyFeed(client, bountyId);
  const mine = feed.subs.find((s) => s.id === sub.id);
  const done = mine && (mine.status === "paid" || mine.status === "rejected" || mine.status === "closed");
  useEffect(() => {
    if (feed.error) exit(feed.error);
  }, [feed.error, exit]);
  useEffect(() => {
    if (!done) return;
    if (mine?.status === "rejected") process.exitCode = 2;
    const t = setTimeout(() => exit(), 50);
    return () => clearTimeout(t);
  }, [done, mine?.status, exit]);
  if (feed.error) return <ErrorLine message={feed.error.message} />;
  if (!feed.bounty) return null;
  return (
    <Box flexDirection="column">
      <FeedView feed={{ ...feed, log: feed.log.filter((e) => e.subId === sub.id) }} source={client.source} width={width} now={now} focus={sub.id} />
      {mine?.status === "waiting" && <T tone="pending"> ◷ Verified. Waiting for the creator to accept on the web page.</T>}
      {!done && <T tone="muted"> Ctrl+C to stop watching; the submission keeps going.</T>}
    </Box>
  );
}

export function RunView({
  client,
  agent,
  bountyId,
  width,
  now,
}: {
  client: BountyClient;
  agent: CodingAgent;
  bountyId: string;
  width: number;
  now?: number;
}) {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "agent" });

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      const bounty = await client.getBounty(bountyId);
      if (bounty.state !== "OPEN") throw new Error(`Bounty ${bounty.id} is ${bounty.state.toLowerCase()}; nothing to run.`);
      const { commitHash } = await agent.run(bounty, (line) => setLines((l) => [...l, line]), ctrl.signal);
      const sub = await client.submit({ bountyId, agentId: agent.id, commitHash });
      setPhase({ kind: "submitted", sub });
    })().catch((err: unknown) => {
      if (ctrl.signal.aborted) return;
      const error = err instanceof Error ? err : new Error(String(err));
      setPhase({ kind: "error", error });
    });
    return () => ctrl.abort();
  }, [client, agent, bountyId]);

  useEffect(() => {
    if (phase.kind === "error") exit(phase.error);
  }, [phase, exit]);

  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        <T bold>Agent</T> <T tone="accent">{agent.id}</T>
        <T tone="muted"> → {bountyId} · {agent.description}</T>
      </Text>
      {lines.map((line, i) => {
        const current = phase.kind === "agent" && i === lines.length - 1;
        return (
          <Text key={i}>
            {"   "}
            {current ? <Spin /> : <T tone="ok">✓</T>} {line}
          </Text>
        );
      })}
      {phase.kind === "error" && <ErrorLine message={phase.error.message} />}
      {phase.kind === "submitted" && (
        <>
          <Text>
            {"   "}
            <T tone="ok">✓</T> Submitted <T bold>{phase.sub.id}</T> at commit {shortCommit(phase.sub.commitHash)}
          </Text>
          <Text> </Text>
          <Live client={client} bountyId={bountyId} sub={phase.sub} width={width} now={now} />
        </>
      )}
    </Box>
  );
}
