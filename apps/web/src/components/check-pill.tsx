import { CircleCheck, CircleDashed, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import type { CheckStatus } from "@/lib/workflow";
import { cn } from "@/lib/utils";

const STYLE: Record<CheckStatus, { icon: typeof CircleCheck; className: string; text: string }> = {
  verified: { icon: CircleCheck, className: "text-success", text: "verified" },
  failed: { icon: CircleX, className: "text-destructive", text: "failed" },
  running: { icon: LoaderCircle, className: "text-warning [&>svg]:animate-spin", text: "running" },
  pending: { icon: CircleDashed, className: "text-muted-foreground", text: "pending" },
  skipped: { icon: CircleMinus, className: "text-muted-foreground", text: "skipped" },
};

export function CheckPill({ label, status }: { label: string; status: CheckStatus }) {
  const { icon: Icon, className, text } = STYLE[status];
  return (
    <span
      title={`${label}: ${text}`}
      className={cn("inline-flex items-center gap-1.5 text-sm", className)}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={cn(status === "pending" || status === "skipped" ? "" : "text-foreground")}>{label}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
