import { Box, Text } from "ink";
import type { BountyClient, ReceiptView, SubmissionView } from "../../api/types";
import { fit, formatClock, RECEIPT_LABEL, shortCommit, shortHash } from "../../format";
import { ErrorLine, Spin, T } from "../components";
import { useOneShot } from "../hooks";

async function load(client: BountyClient, submissionId: string) {
  const receipts = await client.getReceipts(submissionId);
  let sub: SubmissionView | undefined;
  const bountyId = receipts[0]?.bountyId;
  if (bountyId) sub = (await client.listSubmissions(bountyId)).find((s) => s.id === submissionId);
  return { receipts, sub };
}

/** A receipt counts only if it is bound to the submission's exact commit. */
export function isBound(r: ReceiptView, sub?: SubmissionView): boolean {
  return !!sub && r.commitHash.toLowerCase() === sub.commitHash.toLowerCase() && r.submissionId === sub.id;
}

export function ReceiptsView({ client, submissionId, width }: { client: BountyClient; submissionId: string; width: number }) {
  const { data, error } = useOneShot(() => load(client, submissionId));
  if (error) return <ErrorLine message={error.message} />;
  if (!data)
    return (
      <Text>
        <Spin /> Loading receipts for {submissionId}
      </Text>
    );
  const { receipts, sub } = data;
  const wide = width >= 90;
  const unbound = receipts.filter((r) => !isBound(r, sub)).length;
  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        <T bold>Receipts</T> <T tone="accent">{submissionId}</T>
        {sub && (
          <T tone="muted">
            {" "}
            · bounty {sub.bountyId} · {sub.agentId} · commit {shortCommit(sub.commitHash)}
          </T>
        )}
      </Text>
      <Text> </Text>
      {receipts.length === 0 ? (
        <T tone="muted"> No receipts yet.</T>
      ) : (
        <>
          <Text bold>
            {" "}
            {fit("TYPE", 11)}
            {fit("RESULT", 9)}
            {fit("COMMIT", 9)}
            {fit("DIGEST", 15)}
            {fit("SIGNER", 15)}
            {fit("TIME", 10)}
            {wide ? fit("RUNNER", 14) : ""}
          </Text>
          {receipts.map((r) => (
            <Text key={r.digest}>
              {" "}
              {fit(RECEIPT_LABEL[r.receiptType], 11)}
              <T tone={r.result ? "ok" : "bad"}>{fit(r.result ? "✓ pass" : "✗ fail", 9)}</T>
              <T tone={isBound(r, sub) ? "plain" : "bad"}>{fit(shortCommit(r.commitHash), 9)}</T>
              {fit(shortHash(r.digest), 15)}
              <T tone="muted">{fit(shortHash(r.signer), 15)}</T>
              <T tone="muted">{fit(formatClock(r.timestamp), 10)}</T>
              {wide ? <T tone="muted">{fit(r.runnerVersion, 14)}</T> : ""}
            </Text>
          ))}
          <Text> </Text>
          {unbound === 0 ? (
            <Text>
              {" "}
              <T tone="ok">✓ All {receipts.length} receipts bound to commit {sub ? shortCommit(sub.commitHash) : "?"}</T>
            </Text>
          ) : (
            <Text>
              {" "}
              <T tone="bad">
                ✗ {unbound} of {receipts.length} receipts do not match the submission commit
              </T>
            </Text>
          )}
          {sub?.payoutTx && (
            <Text>
              {" "}
              <T tone="ok">✓ Payout tx</T> {shortHash(sub.payoutTx, 10, 8)}
            </Text>
          )}
        </>
      )}
    </Box>
  );
}
