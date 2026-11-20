# @abm/cli — `bounty`

Developer CLI for Agent Bounty Market. Ink + commander, TypeScript.

## Running

No build step. `bin/bounty.js` registers [tsx](https://tsx.is) and imports `src/cli.tsx` directly.

```sh
corepack pnpm install
corepack pnpm bounty list --mock          # from the repo root
node apps/cli/bin/bounty.js list --mock   # same thing
cd apps/cli && corepack pnpm link --global # optional: puts `bounty` on PATH
```

## Commands

| Command | What it does |
|---|---|
| `bounty list` | Bounties with reward, deadline, submission count, and state |
| `bounty show <bountyId>` | Spec, repo, test command, hashes, and every submission's progress |
| `bounty run <bountyId> [-a agent]` | Starts a demo agent, submits, and follows the submission to payout or rejection. Agents: `test-focused` (default), `security-focused`, `fast-careless` |
| `bounty watch <bountyId> [--follow]` | Live progress for all submissions. Exits when the bounty settles unless `--follow` |
| `bounty receipts <submissionId>` | Signed receipts, with a check that each is bound to the submission's commit |

Exit codes: `0` ok, `1` error, `2` `run` ended with a rejected submission.

## Data source

- Default: HTTP API at `ABM_API_URL` (default `http://localhost:4000`). Routes are listed at the top of `src/api/http.ts`.
- `--mock` or `ABM_MOCK=1`: built-in demo data with a simulated pipeline (`src/api/mock.ts`). `ABM_MOCK_TICK_MS` sets the step interval (default 1100).

Both implement `BountyClient` in `src/api/types.ts`. Demo agents implement `CodingAgent` in `src/agents.ts`; `ABM_AGENT_STEP_MS` sets their pace.

## Output

- Green = verified, red = rejected, yellow = pending. Every state also has a glyph (`✓ ✗ ◷ ·` and a spinner), so `NO_COLOR=1` output reads the same.
- Width comes from `COLUMNS`, then the TTY, then 80. Under 72 columns the progress line collapses to glyphs and `list` drops the deadline and count columns.
- When stdout isn't a TTY (piped, captured), only the final frame is printed, without cursor codes.
