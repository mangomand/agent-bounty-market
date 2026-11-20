"use client";

import type { Hex } from "@abm/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";
import { BountyStateBadge } from "@/components/bounty-state-badge";
import { CheckPill } from "@/components/check-pill";
import { ErrorNote, Loading } from "@/components/state";
import { TxLink } from "@/components/tx-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMounted } from "@/components/wallet-button";
import { api, type BountyView, type SubmissionView } from "@/lib/api";
import { config } from "@/lib/config";
import { acceptSubmission } from "@/lib/contracts";
import { formatDate, formatRelative, formatUsdc, shortHex } from "@/lib/format";
import { useLiveEvents } from "@/lib/use-live-events";
import { CHECKS, canAccept, checkStatus } from "@/lib/workflow";

export default function BountyPage() {
  const { id } = useParams<{ id: string }>();
  const live = useLiveEvents(id) === "live";
  const bounty = useQuery({ queryKey: ["bounty", id], queryFn: () => api().getBounty(id) });
  const open = bounty.data?.state === "OPEN";
  const submissions = useQuery({
    queryKey: ["submissions", id],
    queryFn: () => api().listSubmissions(id),
    enabled: bounty.isSuccess,
    // SSE pushes changes; poll only while the stream is down.
    refetchInterval: open && !live ? 3_000 : false,
  });

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Bounties
      </Link>

      {bounty.isPending && <Loading />}
      {bounty.error && <ErrorNote error={bounty.error} />}
      {bounty.data && (
        <>
          <BountyHeader bounty={bounty.data} />
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-semibold">Submissions</h2>
              {live ? (
                <LiveDot />
              ) : (
                open && submissions.data && <span className="text-xs text-muted-foreground">Updates every 3s</span>
              )}
            </div>
            {submissions.isPending && <Loading />}
            {submissions.error && <ErrorNote error={submissions.error} />}
            {submissions.data?.length === 0 && (
              <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
                No submissions yet. Agents submit through the MCP server.
              </div>
            )}
            {submissions.data && submissions.data.length > 0 && (
              <ul className="flex flex-col gap-3">
                {submissions.data.map((s) => (
                  <SubmissionRow key={s.id} bounty={bounty.data} submission={s} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function LiveDot() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-success" aria-hidden />
      Live
    </span>
  );
}

function BountyHeader({ bounty }: { bounty: BountyView }) {
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardTitle className="text-xl">{bounty.title}</CardTitle>
          <span className="shrink-0 text-xl font-semibold tabular-nums">{formatUsdc(bounty.amountUsdc)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <BountyStateBadge state={bounty.state} deadline={bounty.deadline} />
          <span title={formatDate(bounty.deadline)}>
            Deadline {formatDate(bounty.deadline)}
            {bounty.state === "OPEN" && ` (${formatRelative(bounty.deadline)})`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Test command</dt>
          <dd className="min-w-0 break-all font-mono">{bounty.testCommand}</dd>
          <dt className="text-muted-foreground">Spec hash</dt>
          <dd className="min-w-0 font-mono" title={bounty.specHash}>
            {shortHex(bounty.specHash, 8)}
          </dd>
          <dt className="text-muted-foreground">Escrow</dt>
          <dd className="min-w-0">
            {bounty.fundTx ? <TxLink hash={bounty.fundTx} /> : <span className="text-muted-foreground">Not funded</span>}
          </dd>
          <dt className="text-muted-foreground">Creator</dt>
          <dd className="min-w-0 font-mono" title={bounty.creator}>
            {shortHex(bounty.creator)}
          </dd>
        </dl>
        <details className="group rounded-lg border bg-background/50">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">Spec</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t px-3 py-3 font-mono text-[13px] leading-relaxed">
            {bounty.spec}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

function SubmissionRow({ bounty, submission: s }: { bounty: BountyView; submission: SubmissionView }) {
  const mounted = useMounted();
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [payoutTx, setPayoutTx] = useState<Hex | undefined>(s.payoutTx);

  const accept = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Connect the creator wallet");
      const onchainId = s.onchainId ?? (config.mock ? s.id : null);
      if (!onchainId) throw new Error("This submission is not registered onchain");
      const txHash = await acceptSubmission(onchainId);
      setPayoutTx(txHash);
      return api().acceptSubmission(s.id, { creator: address, txHash });
    },
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["bounty", bounty.id] });
      void queryClient.invalidateQueries({ queryKey: ["submissions", bounty.id] });
      void queryClient.invalidateQueries({ queryKey: ["bounties"] });
    },
  });

  const paid = s.state === "PAYOUT" || s.state === "CREATOR_ACCEPTED";
  const tx = s.payoutTx ?? payoutTx;
  const isCreator = mounted && !!address && address.toLowerCase() === bounty.creator.toLowerCase();
  const closed = bounty.state !== "OPEN";
  const acceptable = !closed && canAccept(s);

  return (
    <li>
      <Card className="gap-4 py-4">
        <CardContent className="flex flex-col gap-4 px-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium">{s.agentId}</span>
              <span className="text-sm text-muted-foreground">
                <span className="font-mono" title={s.commitHash}>
                  {s.commitHash.slice(0, 7)}
                </span>
                {" · "}
                {formatRelative(s.createdAt)}
              </span>
            </div>
            {paid ? (
              <Badge variant="success">Paid</Badge>
            ) : s.failure ? (
              <Badge variant="destructive">Rejected</Badge>
            ) : closed ? (
              <Badge variant="secondary">Closed</Badge>
            ) : acceptable ? (
              <Badge variant="outline">Ready to accept</Badge>
            ) : (
              <Badge variant="warning">Verifying</Badge>
            )}
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {CHECKS.map((c) => (
              <CheckPill key={c.name} label={c.label} status={checkStatus(s, c.state, closed)} />
            ))}
          </div>

          {s.failure && <p className="text-sm text-muted-foreground">{s.failure.reason}</p>}

          {tx && (paid || accept.isPending) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-sm">
              <span className="text-muted-foreground">
                {paid ? `Paid ${formatUsdc(bounty.amountUsdc)}` : "Recording acceptance…"}
              </span>
              <TxLink hash={tx} />
            </div>
          )}

          {acceptable && !paid && (
            <div className="flex flex-col gap-3 border-t pt-4">
              {accept.error && <ErrorNote error={accept.error} />}
              {confirming ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm">
                    Pay {formatUsdc(bounty.amountUsdc)} for commit{" "}
                    <span className="font-mono">{s.commitHash.slice(0, 7)}</span>? This can&apos;t be undone.
                  </p>
                  <div className="flex gap-2 sm:shrink-0">
                    <Button
                      variant="outline"
                      className="flex-1 sm:flex-none"
                      disabled={accept.isPending}
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </Button>
                    <Button className="flex-1 sm:flex-none" disabled={accept.isPending} onClick={() => accept.mutate()}>
                      {accept.isPending ? "Confirm in wallet…" : "Accept and pay"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    {isCreator ? "All checks passed for this commit." : "Connect the creator wallet to accept."}
                  </p>
                  <Button className="sm:shrink-0" disabled={!isCreator} onClick={() => setConfirming(true)}>
                    Accept
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
