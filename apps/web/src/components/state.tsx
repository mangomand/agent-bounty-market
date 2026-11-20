import { CircleAlert, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function ErrorNote({ error, children }: { error: unknown; children?: ReactNode }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 break-words">
        {message}
        {children}
      </div>
    </div>
  );
}
