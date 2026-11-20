import { EventEmitter } from "node:events";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer as createMcpServer, httpApi } from "@abm/mcp";
import {
  MAX_TARBALL_BYTES,
  acceptSubmissionSchema,
  createBountySchema,
  createSubmissionSchema,
  fundBountySchema,
  type Hex,
  idSchema,
  postReceiptsSchema,
  requestRunSchema,
  type ApiBounty,
  type ApiEvent,
  type ApiRun,
  type ApiSubmission,
  type RunJob,
  type RunKind,
  type RunnerClient,
  type SignedReceipt,
  type WorkflowState,
} from "@abm/shared";
import { ChainError, type ChainClient } from "./chain";
import { type Db, newId, now as defaultNow, toBounty, toReceipt, toRun, toSubmission } from "./db";

export interface AppOptions {
  db: Db;
  runner: RunnerClient;
  /** Lowercase runner signer addresses. Empty = accept any signer (the contract still enforces its allowlist). */
  runnerSigners?: string[];
  /** Origins allowed by CORS (the creator web page). */
  corsOrigins?: string[];
  /**
   * Onchain side: verifies funding and payout txs, registers submissions, relays receipts.
   * When unset the API runs offchain only (unit tests).
   */
  chain?: ChainClient;
  /** Start the test run on submit and the security run once tests verify. */
  autoRun?: boolean;
  now?: () => number;
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 502,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Receipt type → [state the submission must be in, state it moves to on a passing result, check it updates]. */
const RECEIPT_STEPS = {
  BuildReceipt: ["CODE_SUBMITTED", "BUILD_VERIFIED", "build"],
  TestReceipt: ["BUILD_VERIFIED", "TESTS_VERIFIED", "test"],
  SecurityReviewReceipt: ["TESTS_VERIFIED", "SECURITY_REVIEWED", "security"],
} as const satisfies Record<string, readonly [WorkflowState, WorkflowState, "build" | "test" | "security"]>;

/** State a submission must be in before a run of this kind can start. */
const RUN_REQUIRES: Record<RunKind, WorkflowState> = { test: "CODE_SUBMITTED", security: "TESTS_VERIFIED" };

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "invalid_request", z.prettifyError(r.error), r.error.issues);
  return r.data;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "request body must be JSON");
  }
}

export function createApp(opts: AppOptions) {
  const { db, runner, chain } = opts;
  const now = opts.now ?? defaultNow;
  const signers = new Set((opts.runnerSigners ?? []).map((s) => s.toLowerCase()));
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pendingRuns = new Set<Promise<void>>();

  const emit = (e: ApiEvent) => events.emit("event", e);

  // ---------- data access ----------

  const getBounty = (id: string): ApiBounty | null => {
    const row = db.prepare("SELECT * FROM bounties WHERE id = ?").get(id);
    if (!row) return null;
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE bounty_id = ?").get(id) as { n: number };
    return toBounty(row, Number(n));
  };
  const mustBounty = (id: string) => {
    const b = getBounty(id);
    if (!b) throw new HttpError(404, "not_found", `bounty ${id} not found`);
    return b;
  };
  const getSubmission = (id: string): ApiSubmission | null => {
    const row = db.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
    return row ? toSubmission(row) : null;
  };
  const mustSubmission = (id: string) => {
    const s = getSubmission(id);
    if (!s) throw new HttpError(404, "not_found", `submission ${id} not found`);
    return s;
  };
  const listRuns = (submissionId: string): ApiRun[] =>
    db.prepare("SELECT * FROM runs WHERE submission_id = ? ORDER BY started_at, rowid").all(submissionId).map(toRun);

  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  /** Sets the submission's state to what the contract says. The contract is the source of truth. */
  const syncFromChain = async (submissionId: string) => {
    const sub = mustSubmission(submissionId);
    if (!chain || !sub.onchainId) return sub;
    const state = await chain.submissionState(sub.onchainId);
    if (state !== sub.state) db.prepare("UPDATE submissions SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), sub.id);
    return mustSubmission(submissionId);
  };

  const chainCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ChainError) throw new HttpError(e.reason ? 409 : 422, "onchain_rejected", e.message);
      throw new HttpError(502, "chain_unavailable", `chain request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Validate and store receipts for one submission, then relay the passing ones to the contract,
   * which re-verifies the signature, signer role, commit, expiry, replay, and step order.
   * Offchain storage is all-or-nothing; the final state always mirrors the contract.
   */
  const ingestReceipts = async (submissionId: string, receipts: SignedReceipt[]) => {
    const stored = tx(() => {
      const out = [];
      for (const r of receipts) {
        const sub = mustSubmission(submissionId);
        const bounty = mustBounty(sub.bountyId);
        if (r.submissionId !== sub.id && r.submissionId !== sub.onchainId)
          throw new HttpError(422, "wrong_submission", "receipt is for a different submission");
        if (r.bountyId !== bounty.id && r.bountyId !== bounty.onchainId)
          throw new HttpError(422, "wrong_bounty", "receipt is for a different bounty");
        if (r.commitHash !== sub.commitHash) throw new HttpError(422, "wrong_commit", "receipt commit does not match submission");
        if (r.expiry <= now()) throw new HttpError(422, "expired", "receipt has expired");
        if (signers.size > 0 && !signers.has(r.signer.toLowerCase()))
          throw new HttpError(403, "unapproved_signer", "receipt signer is not an approved runner");
        if (r.receiptType === "CreatorAcceptance")
          throw new HttpError(422, "bad_receipt_type", "creator acceptance is recorded via POST /submissions/:id/accept");
        const [requires, advancesTo, check] = RECEIPT_STEPS[r.receiptType];
        if (sub.state !== requires)
          throw new HttpError(409, "out_of_order", `${r.receiptType} requires state ${requires}, submission is ${sub.state}`);
        if (db.prepare("SELECT 1 FROM receipts WHERE signature = ?").get(r.signature))
          throw new HttpError(409, "replayed_receipt", "receipt already used");

        const id = newId("rcpt");
        db.prepare(
          `INSERT INTO receipts (id, submission_id, bounty_id, commit_hash, receipt_type, runner_version, result,
             timestamp, expiry, signature, signer, logs_hash, digest, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(id, sub.id, r.bountyId, r.commitHash, r.receiptType, r.runnerVersion, r.result ? 1 : 0, r.timestamp, r.expiry,
          r.signature, r.signer, r.logsHash ?? null, chain?.receiptDigest(r) ?? null, now());
        db.prepare(`UPDATE submissions SET state = ?, ${check}_status = ?, updated_at = ? WHERE id = ?`).run(
          r.result ? advancesTo : sub.state,
          r.result ? "passed" : "failed",
          now(),
          sub.id,
        );
        out.push(id);
      }
      return out;
    });

    let relayError: HttpError | undefined;
    if (chain && mustSubmission(submissionId).onchainId) {
      for (const [i, r] of receipts.entries()) {
        if (!r.result) continue; // the contract only accepts passing receipts
        try {
          const { txHash } = await chainCall(() => chain.relayReceipt(r));
          db.prepare("UPDATE receipts SET tx_hash = ? WHERE id = ?").run(txHash, stored[i]!);
        } catch (e) {
          relayError = e instanceof HttpError ? e : new HttpError(502, "chain_unavailable", String(e));
          const check = RECEIPT_STEPS[r.receiptType as keyof typeof RECEIPT_STEPS][2];
          db.prepare(`UPDATE submissions SET ${check}_status = 'error', updated_at = ? WHERE id = ?`).run(now(), submissionId);
          break;
        }
      }
      await syncFromChain(submissionId).catch(() => undefined);
    }

    const sub = mustSubmission(submissionId);
    const out = stored.map((id) => toReceipt(db.prepare("SELECT * FROM receipts WHERE id = ?").get(id)!));
    for (const receipt of out) emit({ type: "receipt.created", bountyId: sub.bountyId, receipt });
    emit({ type: "submission.updated", bountyId: sub.bountyId, submission: sub });
    if (relayError) throw relayError;
    return out;
  };

  const setChecks = (sub: ApiSubmission, kind: RunKind, status: "running" | "error") => {
    const cols = kind === "test" ? ["build", "test"] : ["security"];
    // Only touch checks without a result yet; a retry also restarts checks the runner errored on.
    const from = status === "running" ? "('pending','running','error')" : "('pending','running')";
    for (const col of cols) {
      db.prepare(`UPDATE submissions SET ${col}_status = ?, updated_at = ? WHERE id = ? AND ${col}_status IN ${from}`)
        .run(status, now(), sub.id);
    }
    emit({ type: "submission.updated", bountyId: sub.bountyId, submission: mustSubmission(sub.id) });
  };

  const startRun = (sub: ApiSubmission, kind: RunKind): ApiRun => {
    const bounty = mustBounty(sub.bountyId);
    if (bounty.state !== "OPEN") throw new HttpError(409, "bounty_closed", `bounty is ${bounty.state}`);
    if (sub.state !== RUN_REQUIRES[kind])
      throw new HttpError(409, "out_of_order", `${kind} run requires state ${RUN_REQUIRES[kind]}, submission is ${sub.state}`);
    if (db.prepare("SELECT 1 FROM runs WHERE submission_id = ? AND kind = ? AND status = 'running'").get(sub.id, kind))
      throw new HttpError(409, "run_in_progress", `a ${kind} run is already in progress`);
    // A runner error (not a failing test) can be retried on the same commit.
    if (kind === "test" && !["pending", "error"].includes(sub.checks.build))
      throw new HttpError(409, "already_run", "this submission was already tested; submit a new commit");

    const runId = newId("run");
    db.prepare("INSERT INTO runs (id, submission_id, kind, status, started_at) VALUES (?,?,?,?,?)").run(
      runId, sub.id, kind, "running", now());
    const run = toRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)!);
    emit({ type: "run.started", bountyId: sub.bountyId, run });
    setChecks(sub, kind, "running");

    const row = db.prepare("SELECT repo_url, tarball FROM submissions WHERE id = ?").get(sub.id) as {
      repo_url: string | null;
      tarball: Uint8Array | null;
    };
    const job: RunJob = {
      runId,
      kind,
      bounty,
      submission: mustSubmission(sub.id),
      source: row.repo_url
        ? { kind: "git", repoUrl: row.repo_url, commitHash: sub.commitHash }
        : { kind: "tarball", base64: Buffer.from(row.tarball ?? new Uint8Array()).toString("base64") },
    };

    const p = (async () => {
      let error: string | null = null;
      try {
        const result = await runner.run(job);
        if (result.logs) db.prepare("UPDATE runs SET logs = ? WHERE id = ?").run(result.logs, runId);
        if (result.receipts.length > 0) await ingestReceipts(sub.id, result.receipts);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        setChecks(sub, kind, "error");
      }
      db.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(
        error ? "error" : "finished", error, now(), runId);
      emit({ type: "run.finished", bountyId: sub.bountyId, run: toRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)!) });
      const after = mustSubmission(sub.id);
      if (opts.autoRun && !error && kind === "test" && after.state === "TESTS_VERIFIED") {
        try {
          startRun(after, "security");
        } catch (e) {
          console.error(`auto security run for ${sub.id} not started: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
    pendingRuns.add(p);
    void p.finally(() => pendingRuns.delete(p));
    return run;
  };

  // ---------- routes ----------

  const app = new Hono();

  app.use("*", cors({ origin: opts.corsOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"] }));
  app.use("*", bodyLimit({ maxSize: MAX_TARBALL_BYTES * 2, onError: (c) => c.json({ error: { code: "too_large", message: "request body too large" } }, 413) }));

  app.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    console.error(err);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "route not found" } }, 404));

  const bountyId = (c: Context) => parse(idSchema("bty"), c.req.param("id"));
  const submissionId = (c: Context) => parse(idSchema("sub"), c.req.param("id"));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/bounties", (c) => {
    const state = parse(z.enum(["OPEN", "AWARDED", "REFUNDED"]).optional(), c.req.query("state"));
    const rows = state
      ? db.prepare("SELECT id FROM bounties WHERE state = ? ORDER BY created_at DESC, rowid DESC").all(state)
      : db.prepare("SELECT id FROM bounties ORDER BY created_at DESC, rowid DESC").all();
    return c.json({ bounties: rows.map((r) => mustBounty(String(r.id))) });
  });

  /** Confirms the creator's createBounty tx matches this bounty; returns the contract's bounty id. */
  const verifyFunding = async (b: Pick<ApiBounty, "creator" | "specHash" | "testSuiteHash" | "amountUsdc" | "deadline">, txHash: Hex) => {
    if (!chain) throw new HttpError(409, "no_chain", "no chain configured");
    return (await chainCall(() => chain.verifyFunding(txHash, b))).onchainId;
  };

  app.post("/bounties", async (c) => {
    const b = parse(createBountySchema, await jsonBody(c));
    if (b.deadline <= now()) throw new HttpError(400, "invalid_request", "deadline must be in the future");
    if (chain && (b.onchainId || b.fundTxHash)) {
      // Never trust a client-supplied onchain id: derive it from the funding tx.
      if (!b.fundTxHash) throw new HttpError(400, "invalid_request", "onchainId requires fundTxHash");
      const onchainId = await verifyFunding(b, b.fundTxHash);
      if (b.onchainId && b.onchainId !== onchainId) throw new HttpError(422, "onchain_mismatch", "onchainId does not match the funding tx");
      b.onchainId = onchainId;
    }
    const id = newId("bty");
    try {
      db.prepare(
        `INSERT INTO bounties (id, title, description, spec, spec_hash, test_suite_hash, amount_usdc, creator, deadline,
           repo_url, repo_ref, test_command, allow_network, onchain_id, fund_tx_hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, b.title, b.description, b.spec, b.specHash, b.testSuiteHash, b.amountUsdc, b.creator.toLowerCase(), b.deadline,
        b.repoUrl ?? null, b.repoRef ?? null, b.testCommand, b.allowNetwork ? 1 : 0, b.onchainId ?? null, b.fundTxHash ?? null, now());
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "duplicate", "a bounty with this onchainId already exists");
      throw e;
    }
    const bounty = mustBounty(id);
    emit({ type: "bounty.created", bountyId: id, bounty });
    return c.json({ bounty }, 201);
  });

  app.get("/bounties/:id", (c) => c.json({ bounty: mustBounty(bountyId(c)) }));

  /** Records the creator's onchain funding. The API reads the BountyCreated event itself. */
  app.post("/bounties/:id/fund", async (c) => {
    const b = mustBounty(bountyId(c));
    const { txHash } = parse(fundBountySchema, await jsonBody(c));
    if (b.onchainId) throw new HttpError(409, "already_funded", `bounty is already funded onchain as #${b.onchainId}`);
    const onchainId = await verifyFunding(b, txHash);
    try {
      db.prepare("UPDATE bounties SET onchain_id = ?, fund_tx_hash = ? WHERE id = ?").run(onchainId, txHash, b.id);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "duplicate", "that onchain bounty is already linked");
      throw e;
    }
    const bounty = mustBounty(b.id);
    emit({ type: "bounty.updated", bountyId: b.id, bounty });
    return c.json({ bounty });
  });

  app.get("/bounties/:id/repository", (c) => {
    const b = mustBounty(bountyId(c));
    return c.json({ repository: { bountyId: b.id, repoUrl: b.repoUrl, repoRef: b.repoRef, testCommand: b.testCommand, allowNetwork: b.allowNetwork } });
  });

  app.get("/bounties/:id/submissions", (c) => {
    const b = mustBounty(bountyId(c));
    const subs = db.prepare("SELECT * FROM submissions WHERE bounty_id = ? ORDER BY created_at, rowid").all(b.id).map(toSubmission);
    return c.json({ submissions: subs });
  });

  app.post("/bounties/:id/submissions", async (c) => {
    const b = mustBounty(bountyId(c));
    const s = parse(createSubmissionSchema, await jsonBody(c));
    if (b.state !== "OPEN") throw new HttpError(409, "bounty_closed", `bounty is ${b.state}`);
    if (b.deadline <= now()) throw new HttpError(409, "deadline_passed", "bounty deadline has passed");
    let tarball: Buffer | null = null;
    if (s.sourceTarballBase64) {
      tarball = Buffer.from(s.sourceTarballBase64, "base64");
      if (tarball.byteLength > MAX_TARBALL_BYTES) throw new HttpError(413, "too_large", "tarball exceeds 10 MB");
      if (tarball[0] !== 0x1f || tarball[1] !== 0x8b) throw new HttpError(400, "invalid_request", "tarball must be gzip (.tar.gz)");
    }
    let onchain: { onchainId: string; txHash: Hex } | null = null;
    if (chain) {
      if (!b.onchainId) throw new HttpError(409, "not_funded", "bounty is not funded onchain yet");
      // Locks the commit and payout address onchain before any run.
      onchain = await chainCall(() => chain.registerSubmission(b.onchainId!, s.commitHash, s.payoutAddress));
    }
    const id = newId("sub");
    const t = now();
    db.prepare(
      `INSERT INTO submissions (id, bounty_id, agent_id, commit_hash, payout_address, onchain_id, submit_tx_hash, state,
         repo_url, tarball, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, b.id, s.agentId, s.commitHash, s.payoutAddress.toLowerCase(), onchain?.onchainId ?? null, onchain?.txHash ?? null,
      "CODE_SUBMITTED", s.repoUrl ?? null, tarball, t, t);
    const submission = mustSubmission(id);
    emit({ type: "submission.created", bountyId: b.id, submission });
    if (opts.autoRun) startRun(submission, "test");
    return c.json({ submission: mustSubmission(id) }, 201);
  });

  app.get("/submissions/:id", (c) => {
    const s = mustSubmission(submissionId(c));
    return c.json({ submission: s, runs: listRuns(s.id) });
  });

  app.get("/submissions/:id/receipts", (c) => {
    const s = mustSubmission(submissionId(c));
    const receipts = db.prepare("SELECT * FROM receipts WHERE submission_id = ? ORDER BY received_at, rowid").all(s.id).map(toReceipt);
    return c.json({ receipts });
  });

  app.post("/submissions/:id/receipts", async (c) => {
    const s = mustSubmission(submissionId(c));
    const { receipts } = parse(postReceiptsSchema, await jsonBody(c));
    return c.json({ receipts: await ingestReceipts(s.id, receipts) }, 201);
  });

  app.get("/submissions/:id/runs", (c) => c.json({ runs: listRuns(mustSubmission(submissionId(c)).id) }));

  app.post("/submissions/:id/runs", async (c) => {
    const s = mustSubmission(submissionId(c));
    const { kind } = parse(requestRunSchema, await jsonBody(c));
    return c.json({ run: startRun(s, kind) }, 202);
  });

  app.post("/submissions/:id/accept", async (c) => {
    const id = submissionId(c);
    const body = parse(acceptSubmissionSchema, await jsonBody(c));
    if (chain) {
      // The creator's wallet already sent acceptSubmission; check the tx really paid this submission.
      const pre = mustSubmission(id);
      const b = mustBounty(pre.bountyId);
      if (!pre.onchainId) throw new HttpError(409, "out_of_order", "submission is not registered onchain");
      const paid = await chainCall(() => chain.verifyPayout(body.txHash, pre.onchainId!));
      if (paid.from.toLowerCase() !== b.creator.toLowerCase() || body.creator.toLowerCase() !== b.creator.toLowerCase())
        throw new HttpError(403, "not_creator", "payout tx was not sent by the bounty creator");
      if (paid.to.toLowerCase() !== pre.payoutAddress.toLowerCase())
        throw new HttpError(422, "onchain_mismatch", "payout went to a different address");
    }
    const sub = tx(() => {
      const s = mustSubmission(id);
      const b = mustBounty(s.bountyId);
      if (b.creator.toLowerCase() !== body.creator.toLowerCase())
        throw new HttpError(403, "not_creator", "only the bounty creator can accept");
      if (b.state !== "OPEN") throw new HttpError(409, "bounty_closed", `bounty is ${b.state}`);
      // With a chain, the verified payout tx is the proof; the row may already mirror PAYOUT.
      if (s.state !== "SECURITY_REVIEWED" && !(chain && s.state === "PAYOUT"))
        throw new HttpError(409, "out_of_order", `accept requires state SECURITY_REVIEWED, submission is ${s.state}`);
      const t = now();
      // The contract accepts and pays out in one transaction, so the accept tx is the payout tx.
      db.prepare("UPDATE submissions SET state = 'PAYOUT', accept_tx_hash = ?, updated_at = ? WHERE id = ?").run(body.txHash, t, s.id);
      db.prepare("UPDATE bounties SET state = 'AWARDED', accepted_submission_id = ?, payout_tx_hash = ? WHERE id = ?").run(
        s.id, body.txHash, b.id);
      return mustSubmission(s.id);
    });
    const bounty = mustBounty(sub.bountyId);
    emit({ type: "submission.updated", bountyId: bounty.id, submission: sub });
    emit({ type: "bounty.updated", bountyId: bounty.id, bounty });
    return c.json({ submission: sub, bounty });
  });

  // ---------- MCP over Streamable HTTP ----------
  // Same tools as the stdio server (packages/mcp). Tools call this app in-process through its
  // public routes, so they get exactly the same validation. Stateless: one server per request.
  const mcpApi = httpApi("http://api.internal", (input, init) => Promise.resolve(app.fetch(new Request(input, init))));
  const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  app.all("/mcp", async (c) => {
    // DNS-rebinding guard: only loopback Host headers, and browsers only from allowed origins.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const origin = c.req.header("origin");
    const allowedOrigins = opts.corsOrigins ?? [];
    if (!loopbackHost.test(host) || (origin && !allowedOrigins.includes(origin)))
      throw new HttpError(403, "forbidden_host", "MCP is only served to local clients");
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(mcpApi);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  app.get("/events", (c) => {
    const filter = parse(idSchema("bty").optional(), c.req.query("bountyId"));
    return streamSSE(c, async (stream) => {
      let open = true;
      const listener = (e: ApiEvent) => {
        if (open && (!filter || e.bountyId === filter)) void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      };
      events.on("event", listener);
      stream.onAbort(() => {
        open = false;
        events.off("event", listener);
      });
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ bountyId: filter ?? null }) });
      while (open) {
        await stream.sleep(15_000);
        if (open) await stream.writeSSE({ event: "ping", data: String(now()) });
      }
    });
  });

  return {
    app,
    events,
    /** Resolves when all in-flight runner calls have finished. Used by tests and shutdown. */
    idle: async () => {
      while (pendingRuns.size > 0) await Promise.allSettled([...pendingRuns]);
    },
  };
}
