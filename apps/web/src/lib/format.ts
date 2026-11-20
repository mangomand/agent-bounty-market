export function shortHex(value: string, chars = 4): string {
  if (value.length <= chars * 2 + 4) return value;
  return `${value.slice(0, chars + 2)}…${value.slice(-chars)}`;
}

export function formatUsdc(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} USDC`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "in 3 days", "2 hours ago" relative to `now` (ms). */
export function formatRelative(unixSeconds: number, now = Date.now()): string {
  const diff = unixSeconds * 1000 - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return "just now";
}
