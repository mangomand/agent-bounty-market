"use client";

import type { Hex } from "@abm/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { ErrorNote } from "@/components/state";
import { TxLink } from "@/components/tx-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useConnectWallet, useMounted } from "@/components/wallet-button";
import { api, type BountyView } from "@/lib/api";
import { fundBounty } from "@/lib/contracts";
import { formatUsdc } from "@/lib/format";
import { cn } from "@/lib/utils";
import { validateBounty, type BountyForm, type FormErrors } from "@/lib/validate";

function defaultDeadline(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

export default function NewBountyPage() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const wallet = useConnectWallet();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<BountyForm>({
    title: "",
    spec: "",
    testCommand: "pnpm test",
    amountUsdc: "",
    deadline: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [posted, setPosted] = useState<BountyView>();
  const [fundTx, setFundTx] = useState<Hex>();

  const post = useMutation({
    mutationFn: (input: Parameters<ReturnType<typeof api>["createBounty"]>[0]) => api().createBounty(input),
    onSuccess: (bounty) => {
      setPosted(bounty);
      void queryClient.invalidateQueries({ queryKey: ["bounties"] });
    },
  });

  const fund = useMutation({
    mutationFn: async (bounty: BountyView) => {
      const hash = await fundBounty({
        specHash: bounty.specHash,
        testSuiteHash: bounty.testSuiteHash,
        amountUsdc: bounty.amountUsdc,
        deadline: bounty.deadline,
      });
      // The API checks the BountyCreated event before agents can submit.
      await api().recordFunding(bounty.id, hash);
      return hash;
    },
    onSuccess: (hash) => {
      setFundTx(hash);
      void queryClient.invalidateQueries({ queryKey: ["bounties"] });
    },
  });

  const connected = mounted && isConnected && !!address;
  const step = !connected ? 1 : !posted ? 2 : !fundTx ? 3 : 4;

  function update<K extends keyof BountyForm>(key: K, value: BountyForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!address) return;
    const result = validateBounty({ ...form, deadline: form.deadline || defaultDeadline() });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    post.mutate({ ...result.input, creator: address });
  }

  const locked = !connected || !!posted;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Post a bounty</h1>

      <ol className="grid grid-cols-3 gap-2 text-sm">
        <StepPill n={1} current={step}>Connect</StepPill>
        <StepPill n={2} current={step}>Post spec</StepPill>
        <StepPill n={3} current={step}>Fund</StepPill>
      </ol>

      {!connected && (
        <Card>
          <CardHeader>
            <CardTitle>Connect your wallet</CardTitle>
            <CardDescription>The wallet that funds the bounty is the only one that can accept a submission.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button onClick={wallet.connect} disabled={!mounted || wallet.isPending} className="w-full sm:w-auto sm:self-start">
              {wallet.isPending ? "Connecting…" : "Connect wallet"}
            </Button>
            {wallet.error && <ErrorNote error={wallet.error} />}
          </CardContent>
        </Card>
      )}

      <Card className={cn(!connected && "opacity-60")}>
        <CardHeader>
          <CardTitle>Spec</CardTitle>
          <CardDescription>Locked once posted. Agents are tested against exactly this.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
            <fieldset disabled={locked || post.isPending} className="flex flex-col gap-5">
              <Field id="title" label="Title" error={errors.title}>
                <Input
                  id="title"
                  value={form.title}
                  onChange={(e) => update("title", e.target.value)}
                  placeholder="Rate limiter middleware for Express"
                  aria-invalid={!!errors.title}
                />
              </Field>
              <Field id="spec" label="Spec" hint="Markdown" error={errors.spec}>
                <Textarea
                  id="spec"
                  rows={8}
                  value={form.spec}
                  onChange={(e) => update("spec", e.target.value)}
                  placeholder={"What to build, inputs and outputs, constraints.\n\n- Must pass the test command below"}
                  className="font-mono text-sm md:text-[13px]"
                  aria-invalid={!!errors.spec}
                />
              </Field>
              <Field id="testCommand" label="Test command" error={errors.testCommand}>
                <Input
                  id="testCommand"
                  value={form.testCommand}
                  onChange={(e) => update("testCommand", e.target.value)}
                  className="font-mono"
                  aria-invalid={!!errors.testCommand}
                />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id="amount" label="Amount" hint="USDC" error={errors.amountUsdc}>
                  <Input
                    id="amount"
                    inputMode="decimal"
                    value={form.amountUsdc}
                    onChange={(e) => update("amountUsdc", e.target.value)}
                    placeholder="250"
                    aria-invalid={!!errors.amountUsdc}
                  />
                </Field>
                <Field id="deadline" label="Deadline" error={errors.deadline}>
                  <Input
                    id="deadline"
                    type="datetime-local"
                    value={form.deadline || (mounted ? defaultDeadline() : "")}
                    onChange={(e) => update("deadline", e.target.value)}
                    aria-invalid={!!errors.deadline}
                  />
                </Field>
              </div>
            </fieldset>
            {post.error && <ErrorNote error={post.error} />}
            {!posted && (
              <Button type="submit" disabled={!connected || post.isPending} className="w-full sm:w-auto sm:self-end">
                {post.isPending ? "Posting…" : "Post spec"}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      {posted && (
        <Card>
          <CardHeader>
            <CardTitle>{fundTx ? "Funded" : `Fund ${formatUsdc(posted.amountUsdc)}`}</CardTitle>
            <CardDescription>
              {fundTx
                ? "The USDC is held by the bounty contract until you accept a submission or the deadline passes."
                : "Approve USDC, then escrow it in the bounty contract. Your wallet asks you to sign twice."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {fundTx ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">Transaction</span>
                  <TxLink hash={fundTx} />
                </div>
                <Button asChild className="w-full sm:w-auto sm:self-end">
                  <Link href={`/bounties/${posted.id}`}>View bounty</Link>
                </Button>
              </>
            ) : (
              <>
                {fund.error && <ErrorNote error={fund.error} />}
                <Button
                  onClick={() => fund.mutate(posted)}
                  disabled={fund.isPending}
                  className="w-full sm:w-auto sm:self-end"
                >
                  {fund.isPending ? "Waiting for wallet…" : `Fund ${formatUsdc(posted.amountUsdc)}`}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StepPill({ n, current, children }: { n: number; current: number; children: ReactNode }) {
  const done = current > n;
  const active = current === n;
  return (
    <li
      aria-current={active ? "step" : undefined}
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border px-2 py-2 text-center",
        active && "border-foreground/40 bg-card font-medium",
        !active && !done && "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
          done && "border-success bg-success text-background",
          active && "border-foreground",
        )}
      >
        {done ? <Check className="size-3" /> : n}
      </span>
      {children}
    </li>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
      </Label>
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
