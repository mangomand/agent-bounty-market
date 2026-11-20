"use client";

import type { Hex } from "@abm/shared";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { txUrl } from "@/lib/config";
import { shortHex } from "@/lib/format";

/** Links to the explorer when one is configured; otherwise shows the hash with a copy button. */
export function TxLink({ hash }: { hash: Hex }) {
  const [copied, setCopied] = useState(false);
  const url = txUrl(hash);
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-mono text-sm underline underline-offset-4 hover:text-foreground"
      >
        {shortHex(hash, 6)} <ExternalLink className="size-3.5" />
      </a>
    );
  }
  return (
    <button
      type="button"
      title={hash}
      onClick={() => {
        void navigator.clipboard?.writeText(hash).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 font-mono text-sm hover:text-foreground"
    >
      {shortHex(hash, 6)}
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5 opacity-60" />}
      <span className="sr-only">Copy transaction hash</span>
    </button>
  );
}
