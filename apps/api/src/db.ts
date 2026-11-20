import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import type {
  ApiBounty,
  ApiReceipt,
  ApiRun,
  ApiSubmission,
  CheckStatus,
  Hex,
  RunKind,
  WorkflowState,
} from "@abm/shared";

// Loaded via require: vitest's module loader does not resolve the `node:sqlite` builtin through ESM import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSyncT;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  spec TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  test_suite_hash TEXT NOT NULL,
  amount_usdc TEXT NOT NULL,
  creator TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN',
  repo_url TEXT,
  repo_ref TEXT,
  test_command TEXT NOT NULL,
  allow_network INTEGER NOT NULL DEFAULT 0,
  onchain_id TEXT UNIQUE,
  fund_tx_hash TEXT,
  accepted_submission_id TEXT,
  payout_tx_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  bounty_id TEXT NOT NULL REFERENCES bounties(id),
  agent_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  payout_address TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  onchain_id TEXT,
  submit_tx_hash TEXT,
  state TEXT NOT NULL,
  repo_url TEXT,
  tarball BLOB,
  build_status TEXT NOT NULL DEFAULT 'pending',
  test_status TEXT NOT NULL DEFAULT 'pending',
  security_status TEXT NOT NULL DEFAULT 'pending',
  accept_tx_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_bounty ON submissions(bounty_id);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  bounty_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  runner_version TEXT NOT NULL,
  result INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  expiry INTEGER NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  signer TEXT NOT NULL,
  logs_hash TEXT,
  digest TEXT,
  tx_hash TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_submission ON receipts(submission_id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  logs TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
`;

/** Columns added after the first release; ALTERed into older databases. */
const MIGRATIONS: [table: string, column: string, decl: string][] = [
  ["submissions", "payout_address", "TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000'"],
  ["submissions", "onchain_id", "TEXT"],
  ["submissions", "submit_tx_hash", "TEXT"],
  ["receipts", "digest", "TEXT"],
  ["receipts", "tx_hash", "TEXT"],
  ["runs", "logs", "TEXT"],
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  for (const [table, column, decl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  return db;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export function newId(prefix: "bty" | "sub" | "rcpt" | "run"): string {
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

export const now = () => Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const str = (v: unknown) => v as string;
const strOrNull = (v: unknown) => (v ?? null) as string | null;

export function toBounty(r: Row, submissionCount: number): ApiBounty {
  return {
    id: str(r.id),
    title: str(r.title),
    description: str(r.description),
    spec: str(r.spec),
    specHash: str(r.spec_hash) as Hex,
    testSuiteHash: str(r.test_suite_hash) as Hex,
    amountUsdc: str(r.amount_usdc),
    creator: str(r.creator) as Hex,
    deadline: Number(r.deadline),
    state: str(r.state) as ApiBounty["state"],
    repoUrl: strOrNull(r.repo_url),
    repoRef: strOrNull(r.repo_ref),
    testCommand: str(r.test_command),
    allowNetwork: Number(r.allow_network) === 1,
    onchainId: strOrNull(r.onchain_id),
    fundTxHash: strOrNull(r.fund_tx_hash) as Hex | null,
    acceptedSubmissionId: strOrNull(r.accepted_submission_id),
    payoutTxHash: strOrNull(r.payout_tx_hash) as Hex | null,
    createdAt: Number(r.created_at),
    submissionCount,
  };
}

export function toSubmission(r: Row): ApiSubmission {
  const tarball = r.tarball as Uint8Array | null;
  return {
    id: str(r.id),
    bountyId: str(r.bounty_id),
    agentId: str(r.agent_id),
    commitHash: str(r.commit_hash),
    state: str(r.state) as WorkflowState,
    source: r.repo_url
      ? { kind: "git", repoUrl: str(r.repo_url) }
      : { kind: "tarball", bytes: tarball ? tarball.byteLength : 0 },
    checks: {
      build: str(r.build_status) as CheckStatus,
      test: str(r.test_status) as CheckStatus,
      security: str(r.security_status) as CheckStatus,
    },
    payoutAddress: str(r.payout_address) as Hex,
    onchainId: strOrNull(r.onchain_id),
    submitTxHash: strOrNull(r.submit_tx_hash) as Hex | null,
    acceptTxHash: strOrNull(r.accept_tx_hash) as Hex | null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function toReceipt(r: Row): ApiReceipt {
  return {
    id: str(r.id),
    bountyId: str(r.bounty_id),
    submissionId: str(r.submission_id),
    commitHash: str(r.commit_hash),
    receiptType: str(r.receipt_type) as ApiReceipt["receiptType"],
    runnerVersion: str(r.runner_version),
    result: Number(r.result) === 1,
    timestamp: Number(r.timestamp),
    expiry: Number(r.expiry),
    signature: str(r.signature) as Hex,
    signer: str(r.signer) as Hex,
    logsHash: strOrNull(r.logs_hash) as Hex | null,
    digest: strOrNull(r.digest) as Hex | null,
    txHash: strOrNull(r.tx_hash) as Hex | null,
    receivedAt: Number(r.received_at),
  };
}

export function toRun(r: Row): ApiRun {
  return {
    id: str(r.id),
    submissionId: str(r.submission_id),
    kind: str(r.kind) as RunKind,
    status: str(r.status) as ApiRun["status"],
    error: strOrNull(r.error),
    logs: strOrNull(r.logs),
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  };
}
