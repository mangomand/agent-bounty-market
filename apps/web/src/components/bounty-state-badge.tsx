import type { Bounty } from "@abm/shared";
import { Badge } from "@/components/ui/badge";

export function BountyStateBadge({ state, deadline }: Pick<Bounty, "state" | "deadline">) {
  if (state === "AWARDED") return <Badge variant="success">Paid out</Badge>;
  if (state === "REFUNDED") return <Badge variant="secondary">Refunded</Badge>;
  if (deadline * 1000 < Date.now()) return <Badge variant="secondary">Expired</Badge>;
  return <Badge variant="outline">Open</Badge>;
}
