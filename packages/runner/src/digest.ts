import { createHash } from "node:crypto";
import type { Hex } from "@abm/shared";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Strips ANSI codes, normalizes line endings, and trims trailing whitespace. */
export function normalizeOutput(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/** sha256 over normalized stdout and stderr, with a separator so they can't be confused. */
export function testDigest(stdout: string, stderr: string): Hex {
  const h = createHash("sha256");
  h.update(normalizeOutput(stdout));
  h.update("\n\u0000stderr\u0000\n");
  h.update(normalizeOutput(stderr));
  return `0x${h.digest("hex")}`;
}

/** Keeps the last `maxChars` of a log, which is where failures usually are. */
export function truncateLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `[… ${dropped} chars truncated …]\n${text.slice(-maxChars)}`;
}
