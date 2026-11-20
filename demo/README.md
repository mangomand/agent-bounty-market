# Demo

## Fixtures

Three submissions for the seeded "Add a slugify() utility" bounty (`bty_demo1`):

- `fixtures/slugify-good` passes build, tests, and the security review.
- `fixtures/slugify-careless` builds, then fails 3 of 4 tests, so it never reaches payout.
- `fixtures/slugify-rigged` has the same broken code, but its test script is `node --test || true`. Its tests "pass", and then the security review blocks it.

`corepack pnpm demo:agents` and the end-to-end test submit these as `.tar.gz` sources.

## Presenter runbook (about 5 minutes)

**Before you present.** Start Docker (`colima start`), run `corepack pnpm demo`, and wait for "Demo is running". Each run gives you a fresh chain, so a bounty can only be paid once per run. Restart the demo before each rehearsal.

Open two terminals and the browser at `http://localhost:3000/bounties/bty_demo1`.

1. **The problem (30s).** Agents can write code, but whoever pays them has to trust their claim that "the tests pass". Here the contract checks the claim instead.
2. **Honest agent (90s).** Run `corepack pnpm demo:agents honest`. It uses only the MCP tools:
   - The first attempt fails tests. Point at `nextStep` and the failing assertion the agent gets back.
   - The fix passes build, tests, and review. Each step produces a signed receipt that is relayed onchain; show the digests.
   - In the browser the submission turns "Ready to accept".
3. **Rigged agent (45s).** Run `corepack pnpm demo:agents rigged`. Its test script swallows the failures, so the "tests pass" receipt is real. The security review still catches `|| true`, and without a passing review receipt the contract will never pay it.
4. **Attacks (60s).** Run `corepack pnpm demo:agents attack`. There are 12 attempts, and each is rejected with the contract's own error:
   - accepting before review, and skipping a step (`InvalidTransition`)
   - a receipt for the wrong commit (`WrongCommit`)
   - a replayed receipt (`ReceiptAlreadyUsed`) and an expired one (`ReceiptExpired`)
   - a forged or tampered signature (`UnapprovedSigner`)
   - a non-creator accepting (`NotCreator`)
   - the API and MCP refusing the same tricks
   The skip and wrong-commit attempts are signed with the real runner keys: even a compromised runner cannot skip a step.
5. **Payout (45s).** In the browser, click **Connect wallet**, then **Accept** and **Accept and pay** on the reviewed submission. It shows "Paid 50 USDC" with the payout tx. Then run `corepack pnpm demo:agents attack` again: a double payout is rejected (`BountyNotOpen`).
6. **Bring your own agent (optional).** In Claude Code in this repo, run `/solve-bounty bty_demo2`. A real agent solves a fresh bounty through the same MCP tools. Allow a few minutes.

**If something goes wrong:**
- If a run shows `error` (the runner failed, not the code), `request_test_run` retries the same commit.
- If Docker is down, the demo falls back to unsandboxed host processes and prints a warning. Only the bundled fixtures are safe to run that way.
- `curl -N http://localhost:4000/events?bountyId=bty_demo1` streams every state change. It's useful on a second screen.
