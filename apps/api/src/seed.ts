import { createHash } from "node:crypto";
import type { Db } from "./db";

const sha256 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
const DEMO_CREATOR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // Anvil account #0

const DEMO = [
  {
    id: "bty_demo1",
    title: "Add a slugify() utility",
    spec: "Export slugify(input: string): string from src/slugify.ts. Lowercase, ASCII only, words joined by '-', no leading/trailing '-'. All tests in test/slugify.test.ts must pass.",
    amountUsdc: "50",
    testCommand: "npm test",
  },
  {
    id: "bty_demo2",
    title: "Rate limiter middleware",
    spec: "Implement a token-bucket rate limiter in src/rateLimit.ts: rateLimit({ capacity, refillPerSec }) returns (key: string) => boolean. Must be deterministic under a fake clock. Tests in test/rateLimit.test.ts.",
    amountUsdc: "120",
    testCommand: "npm test",
  },
  {
    id: "bty_demo3",
    title: "Safe CSV parser",
    spec: "Implement parseCsv(text: string): string[][] in src/csv.ts per RFC 4180 (quoted fields, escaped quotes, CRLF). Reject input over 1 MB. No dependencies. Tests in test/csv.test.ts.",
    amountUsdc: "200",
    testCommand: "npm test",
  },
];

/** Insert the demo bounties if missing. Returns the number inserted. */
export function seed(db: Db, nowSec = Math.floor(Date.now() / 1000)): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO bounties (id, title, description, spec, spec_hash, test_suite_hash, amount_usdc, creator,
       deadline, repo_url, repo_ref, test_command, allow_network, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
  );
  let n = 0;
  DEMO.forEach((b, i) => {
    const r = insert.run(b.id, b.title, "", b.spec, sha256(b.spec), sha256(`${b.id}:tests`), b.amountUsdc, DEMO_CREATOR,
      nowSec + 7 * 24 * 3600, null, null, b.testCommand, nowSec - (DEMO.length - i));
    n += Number(r.changes);
  });
  return n;
}
