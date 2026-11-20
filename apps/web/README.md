# @abm/web

Creator page: post and fund a bounty, watch submissions, accept one and get the payout tx.

| Route | Screen |
|---|---|
| `/` | Bounty list |
| `/new` | Connect wallet → post spec → fund |
| `/bounties/[id]` | Submissions with build/test/security status; accept and pay |

## Run

The full flow (Anvil, contracts, API, runner) comes up with `corepack pnpm demo` from the repo root. For UI work alone:

```sh
cp apps/web/.env.example apps/web/.env.local
NEXT_PUBLIC_MOCK=1 corepack pnpm --filter @abm/web dev   # no API, chain, or wallet needed
```

`NEXT_PUBLIC_MOCK=1` swaps in an in-memory API and a mock wallet (Anvil account 0). Without it the page
talks to `NEXT_PUBLIC_API_URL` and MetaMask on Anvil (chain 31337, `NEXT_PUBLIC_RPC_URL`).

## Layout

- `src/lib/api/` — API client (`http.ts`), mock (`mock.ts`), shared response types
- `src/lib/contracts.ts` — the only place that sends transactions, using the ABI from `@abm/shared/abi`:
  `approve` + `createBounty` to fund (then `POST /bounties/:id/fund` so the API can verify the event), and
  `acceptSubmission(onchainSubmissionId)` to accept and pay.
- `src/lib/workflow.ts` — maps `WorkflowState` to per-check status
