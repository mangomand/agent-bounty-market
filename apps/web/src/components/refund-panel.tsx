"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAccount } from "wagmi";
import { ErrorNote } from "@/components/state";
import { TxLink } from "@/components/tx-link";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/components/wallet-button";
import { api, type BountyView } from "@/lib/api";
import { config } from "@/lib/config";
import { refundBounty } from "@/lib/contracts";
import { formatUsdc } from "@/lib/format";

/** Max wait for the deadline before re-reading the bounty (setTimeout caps near 24.8 days). */
const MAX_WAIT_MS = 24 * 3600 * 1000;

/**
 * Refund for an expired bounty. Shown to the creator only when the API says the contract would
 * accept `refund`; the creator's wallet sends the tx and the API verifies it.
 */
export function RefundPanel({ bounty }: { bounty: BountyView }) {
  const mounted = useMounted();
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const isCreator = mounted && !!address && address.toLowerCase() === bounty.creator.toLowerCase();

  // canRefund flips when the deadline passes; re-read the bounty then so the button appears.
  const waiting = bounty.state === "OPEN" && !bounty.canRefund && !!(bounty.onchainId ?? (config.mock && bounty.fundTx));
  useEffect(() => {
    if (!waiting) return;
    const ms = (bounty.deadline + 1) * 1000 - Date.now() + 500;
    if (ms > MAX_WAIT_MS) return;
    const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["bounty", bounty.id] }), Math.max(ms, 0));
    return () => clearTimeout(timer);
  }, [waiting, bounty.deadline, bounty.id, queryClient]);

  const refund = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Connect the creator wallet");
      const onchainId = bounty.onchainId ?? (config.mock ? bounty.id : null);
      if (!onchainId) throw new Error("This bounty is not funded onchain");
      const txHash = await refundBounty(onchainId);
      return api().recordRefund(bounty.id, { creator: address, txHash });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["bounty", bounty.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["bounty", bounty.id] });
      void queryClient.invalidateQueries({ queryKey: ["submissions", bounty.id] });
      void queryClient.invalidateQueries({ queryKey: ["bounties"] });
    },
  });

  if (bounty.state === "REFUNDED") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-sm">
        <span className="text-muted-foreground">Refunded {formatUsdc(bounty.amountUsdc)}</span>
        {bounty.refundTx && <TxLink hash={bounty.refundTx} />}
      </div>
    );
  }
  if (!bounty.canRefund || !isCreator) return null;

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      {refund.error && <ErrorNote error={refund.error} />}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          The deadline passed with no accepted submission. Refunding closes the bounty.
        </p>
        <Button variant="outline" className="sm:shrink-0" disabled={refund.isPending} onClick={() => refund.mutate()}>
          {refund.isPending ? "Confirm in wallet…" : `Refund ${formatUsdc(bounty.amountUsdc)}`}
        </Button>
      </div>
    </div>
  );
}
