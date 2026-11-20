import { Box, Text } from "ink";
import type { BountyClient, BountyView } from "../../api/types";
import { fit, formatRelative, formatUsdc } from "../../format";
import { BOUNTY_STATE, ErrorLine, Spin, T } from "../components";
import { useOneShot } from "../hooks";

const COL = { id: 6, reward: 12, deadline: 9, subs: 4, state: 8 };
const GAP = 2;

export function BountyTable({ bounties, width, now }: { bounties: BountyView[]; width: number; now?: number }) {
  // Below 72 columns, drop DEADLINE and SUBS so rows never wrap.
  const wide = width >= 72;
  const fixed = COL.id + COL.reward + COL.state + 1 + (wide ? COL.deadline + COL.subs + GAP * 5 : GAP * 3);
  const titleW = Math.max(12, width - fixed - 1);
  const gap = " ".repeat(GAP);
  return (
    <Box flexDirection="column">
      <Text bold>
        {" "}
        {fit("ID", COL.id)}
        {gap}
        {fit("TITLE", titleW)}
        {gap}
        {fit("REWARD", COL.reward, "right")}
        {gap}
        {wide && fit("DEADLINE", COL.deadline) + gap + fit("SUBS", COL.subs, "right") + gap}
        {"STATE"}
      </Text>
      {bounties.map((b) => {
        const expired = b.state === "OPEN" && b.deadline * 1000 < (now ?? Date.now());
        const state = expired ? { label: "expired", tone: "bad" as const } : BOUNTY_STATE[b.state];
        return (
          <Text key={b.id}>
            {" "}
            <T tone="accent">{fit(b.id, COL.id)}</T>
            {gap}
            {fit(b.title, titleW)}
            {gap}
            <T bold>{fit(formatUsdc(b.amountUsdc), COL.reward, "right")}</T>
            {gap}
            {wide && (
              <>
                <T tone="muted">{fit(b.state === "OPEN" ? formatRelative(b.deadline, now) : "-", COL.deadline)}</T>
                {gap}
                {fit(String(b.submissionCount ?? "-"), COL.subs, "right")}
                {gap}
              </>
            )}
            <T tone={state.tone}>{state.label}</T>
          </Text>
        );
      })}
    </Box>
  );
}

export function ListView({ client, width, now }: { client: BountyClient; width: number; now?: number }) {
  const { data, error } = useOneShot(() => client.listBounties());
  if (error) return <ErrorLine message={error.message} />;
  if (!data)
    return (
      <Text>
        <Spin /> Loading bounties from {client.source}
      </Text>
    );
  const open = data.filter((b) => b.state === "OPEN");
  const pool = open.reduce((sum, b) => sum + BigInt(b.amountUsdc), 0n);
  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        <T bold>Bounties</T>
        <T tone="muted">
          {" "}
          · {open.length} open · {formatUsdc(pool.toString())} available · source {client.source}
        </T>
      </Text>
      <Text> </Text>
      {data.length === 0 ? <Text> No bounties yet.</Text> : <BountyTable bounties={data} width={width} now={now} />}
      <Text> </Text>
      <T tone="muted"> bounty show {"<id>"} · bounty run {"<id>"} · bounty watch {"<id>"}</T>
    </Box>
  );
}
