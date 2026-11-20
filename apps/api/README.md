# @abm/api

Local HTTP API shared by the creator web page, the developer CLI, the MCP server, and the runner. It is built with Hono and stores data in SQLite (`node:sqlite`).

The API is an index and a coordinator. It never holds bounty funds or any key that can move them. The contract is the only payout authority. The API records the tx hashes that clients send it.

```sh
corepack pnpm --filter @abm/api seed    # insert 3 demo bounties (bty_demo1..3), idempotent
corepack pnpm --filter @abm/api dev     # http://127.0.0.1:4000
```

| Env | Default | |
|---|---|---|
| `API_PORT` | `4000` | Binds to 127.0.0.1 only |
| `API_DB_PATH` | `apps/api/data/abm.db` | Gitignored |
| `RUNNER_URL` | unset | Runner base URL. The API sends `POST {RUNNER_URL}/run` with a `RunJob`. If unset, runs fail with `runner not configured`. |
| `RUNNER_SIGNER_ADDRESSES` | unset | Comma-separated allowlist of runner signers. If unset, the API accepts any signer, but the contract still enforces its own allowlist. |
| `WEB_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | CORS |

Every type below is exported from `@abm/shared` (`packages/shared/src/api.ts`), along with the zod schemas the API validates against.

## Errors

Every non-2xx response has the form `{ "error": { "code": string, "message": string, "details"?: unknown } }`.

| Status | Codes |
|---|---|
| 400 | `invalid_request` (zod issues in `details`), `invalid_json` |
| 403 | `not_creator`, `unapproved_signer` |
| 404 | `not_found` |
| 409 | `out_of_order`, `replayed_receipt`, `run_in_progress`, `already_run`, `bounty_closed`, `deadline_passed`, `duplicate` |
| 413 | `too_large` |
| 422 | `wrong_commit`, `wrong_bounty`, `wrong_submission`, `expired`, `bad_receipt_type` |

Ids look like `bty_…`, `sub_…`, `rcpt_…` and `run_…`. Timestamps are unix seconds.

## Bounties

### `GET /bounties[?state=OPEN|AWARDED|REFUNDED]` → `{ bounties: ApiBounty[] }`
Newest first.

### `GET /bounties/:id` → `{ bounty: ApiBounty }`

### `POST /bounties` → `201 { bounty: ApiBounty }`
Body is `CreateBountyRequest`:

```json
{
  "title": "Add slugify()",
  "spec": "…locked spec text…",
  "specHash": "0x…32 bytes",
  "testSuiteHash": "0x…32 bytes",
  "amountUsdc": "50",
  "deadline": 1800000000,
  "creator": "0x…address",
  "description": "optional",
  "repoUrl": "https://… (optional base repo)",
  "repoRef": "main (optional)",
  "testCommand": "npm test (default)",
  "allowNetwork": false,
  "onchainId": "1 (optional, contract bounty id)",
  "fundTxHash": "0x… (optional)"
}
```

### `GET /bounties/:id/repository` → `{ repository: RepositoryInfo }`
Returns the base repo URL, ref, fixed test command, and network flag. The MCP `download_repository` tool uses this route.

## Submissions

`ApiSubmission.state` follows the shared workflow:
`CODE_SUBMITTED → BUILD_VERIFIED → TESTS_VERIFIED → SECURITY_REVIEWED → PAYOUT`. The contract accepts and pays out in one transaction, so a successful accept moves the submission straight to `PAYOUT`. `checks.{build,test,security}` is one of `pending | running | passed | failed | error`.

### `GET /bounties/:id/submissions` → `{ submissions: ApiSubmission[] }`
Oldest first.

### `POST /bounties/:id/submissions` → `201 { submission: ApiSubmission }`
Body is `{ agentId, commitHash, repoUrl? | sourceTarballBase64? }`, with exactly one source:
- `repoUrl`: a public `https://` git URL that contains `commitHash`.
- `sourceTarballBase64`: a gzip `.tar.gz`, at most 10 MB decoded.

The bounty must be `OPEN` and its deadline must not have passed.

### `GET /submissions/:id` → `{ submission: ApiSubmission, runs: ApiRun[] }`

### `GET /submissions/:id/runs` → `{ runs: ApiRun[] }`

### `POST /submissions/:id/runs` → `202 { run: ApiRun }`
Body is `{ "kind": "test" | "security" }`. This starts a sandbox run through the `RunnerClient`. Results arrive as receipts and SSE events.
- `test` requires `CODE_SUBMITTED`. It produces `BuildReceipt` and `TestReceipt`. Each submission gets one test run; if it fails, submit a new commit.
- `security` requires `TESTS_VERIFIED`. It produces `SecurityReviewReceipt`.

### `POST /submissions/:id/accept` → `{ submission, bounty }`
Body is `{ "creator": "0x…", "txHash": "0x…" }`. The creator's wallet sends the accept/payout transaction to the contract first. This call only records the result. It requires `SECURITY_REVIEWED`, and `creator` must match the bounty creator. The bounty becomes `AWARDED` with `payoutTxHash = txHash`.

## Receipts

### `GET /submissions/:id/receipts` → `{ receipts: ApiReceipt[] }`

### `POST /submissions/:id/receipts` → `201 { receipts: ApiReceipt[] }`
The runner uses this route. Body is `{ receipts: SignedReceipt[] }`, with 1 to 10 receipts that are applied in order, all-or-nothing. Each receipt must:
- match the submission's `submissionId` and `commitHash`, and the bounty's id or `onchainId`
- have `expiry` later than the current time
- come from an allowlisted signer (when `RUNNER_SIGNER_ADDRESSES` is set)
- use a signature that hasn't been seen before (replay protection)
- arrive in workflow order: a Build receipt needs `CODE_SUBMITTED`, a Test receipt needs `BUILD_VERIFIED`, and a SecurityReview receipt needs `TESTS_VERIFIED`

A passing receipt advances the state. A failing receipt is stored and marks the check `failed`. The API does not verify EIP-712 signatures, because the contract does that at payout.

## Runner interface

```ts
interface RunnerClient { run(job: RunJob): Promise<RunResult> } // RunResult = { receipts: SignedReceipt[] }
```

`createApp({ db, runner })` accepts any implementation. `src/runner.ts` ships `httpRunner(RUNNER_URL)`. A runner can also post receipts to the route above itself and return `{ receipts: [] }`.

## Live events (SSE)

### `GET /events[?bountyId=bty_…]`
Uses `text/event-stream`. The SSE `event:` name equals `data.type`, and `data` is a JSON `ApiEvent`. Every event carries `bountyId`.

| event | data |
|---|---|
| `ready` | `{ bountyId \| null }`, sent once on connect |
| `bounty.created` / `bounty.updated` | `{ bounty }` |
| `submission.created` / `submission.updated` | `{ submission }` |
| `run.started` / `run.finished` | `{ run }` |
| `receipt.created` | `{ receipt }` |
| `ping` | unix time, sent every 15 s |

```sh
curl -N 'http://127.0.0.1:4000/events?bountyId=bty_demo1'
```

### `GET /health` → `{ ok: true }`
