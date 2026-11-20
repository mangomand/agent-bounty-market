"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { BountyStateBadge } from "@/components/bounty-state-badge";
import { ErrorNote, Loading } from "@/components/state";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatRelative, formatUsdc } from "@/lib/format";

export default function BountiesPage() {
  const bounties = useQuery({ queryKey: ["bounties"], queryFn: () => api().listBounties() });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Bounties</h1>
        <Button asChild>
          <Link href="/new">
            <Plus /> Post bounty
          </Link>
        </Button>
      </div>

      {bounties.isPending && <Loading />}
      {bounties.error && <ErrorNote error={bounties.error} />}
      {bounties.data?.length === 0 && (
        <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          No bounties yet.
        </div>
      )}
      {bounties.data && bounties.data.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {bounties.data.map((b) => (
            <li key={b.id}>
              <Link
                href={`/bounties/${b.id}`}
                className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-accent/60 sm:px-5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="line-clamp-2 font-medium">{b.title}</span>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <BountyStateBadge state={b.state} deadline={b.deadline} />
                    <span>
                      {b.submissionCount} {b.submissionCount === 1 ? "submission" : "submissions"}
                    </span>
                    {b.state === "OPEN" && <span>Due {formatRelative(b.deadline)}</span>}
                  </div>
                </div>
                <span className="shrink-0 font-semibold tabular-nums">{formatUsdc(b.amountUsdc)}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
