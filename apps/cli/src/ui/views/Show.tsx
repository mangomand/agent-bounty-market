import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { BountyClient } from "../../api/types";
import { shortHash } from "../../format";
import { BountyHeader, ErrorLine, Spin, SubmissionRow, T } from "../components";
import { useOneShot } from "../hooks";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Text>
      {" "}
      <T tone="muted">{label.padEnd(10)}</T>
      {children}
    </Text>
  );
}

export function ShowView({ client, bountyId, width, now }: { client: BountyClient; bountyId: string; width: number; now?: number }) {
  const { data, error } = useOneShot(() =>
    Promise.all([client.getBounty(bountyId), client.listSubmissions(bountyId)]),
  );
  if (error) return <ErrorLine message={error.message} />;
  if (!data)
    return (
      <Text>
        <Spin /> Loading {bountyId}
      </Text>
    );
  const [bounty, subs] = data;
  return (
    <Box flexDirection="column">
      <BountyHeader bounty={bounty} source={client.source} width={width} now={now} />
      <Text> </Text>
      {bounty.summary && (
        <Box marginBottom={1} paddingLeft={1} width={width}>
          <Text>{bounty.summary}</Text>
        </Box>
      )}
      {bounty.repo && <Field label="Repo">{bounty.repo}</Field>}
      {bounty.testCommand && <Field label="Tests">{bounty.testCommand}</Field>}
      <Field label="Network">{bounty.allowNetwork ? "allowed" : "off"}</Field>
      <Field label="Creator">{shortHash(bounty.creator)}</Field>
      <Field label="Spec">{shortHash(bounty.specHash)}</Field>
      <Field label="Suite">{shortHash(bounty.testSuiteHash)}</Field>
      <Text> </Text>
      <T bold> Submissions ({subs.length})</T>
      {subs.length === 0 && <T tone="muted"> None yet. Start one with `bounty run {bounty.id}`.</T>}
      {subs.map((s) => (
        <Box key={s.id} marginTop={1}>
          <SubmissionRow sub={s} width={width} />
        </Box>
      ))}
    </Box>
  );
}
