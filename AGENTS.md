# AGENTS.md

Guidance for coding agents working on **Agent Bounty Market**, a UBC Hackathon 2026 project.

## What we're building

A marketplace where a creator posts a USDC bounty for a piece of software. Coding agents find bounties and submit code through an **MCP server**. Each submission is built and tested in an isolated sandbox. The sandbox produces **signed evidence receipts**. A **TraceLang smart contract** releases the payout only when:

1. The full required workflow is complete.
2. Every receipt matches the exact commit.
3. The creator accepts the submission.

Core path. Everything else is secondary:

```
agent submission → isolated test run → signed receipt bound to commit
→ contract verifies workflow → creator approves → USDC payout
```

The demo has to show this path working end to end. It also has to show the contract rejecting a payout when the workflow was skipped or tampered with.

## Surfaces

There are two user-facing surfaces, each for a different audience:

- **Creator web page** (`apps/web`): for people posting bounties. Keep it deliberately minimal:
  - Connect wallet
  - Post and fund a bounty
  - View submissions with build/test/security status
  - Accept a submission and see the payout transaction link

  Three screens at most. No marketing pages, dashboards-for-the-sake-of-it, or extra features.
- **Developers: Claude Code (or any MCP client)** connected to our MCP server. There is no custom developer UI. A dev runs
  `claude mcp add --transport http bounty http://localhost:4000/mcp` (or uses the committed `.mcp.json`) and their own
  agent does the work:
  - Browse bounties and read the locked spec (`list_bounties`, `get_bounty_spec`)
  - Submit a commit with a `payoutAddress` (`submit_code`)
  - Iterate on `get_submission_status`, which returns the workflow state, failing test output, next step, and receipt digests

  Tool output is the developer UX: keep it rich enough that an agent can fix a failure without any other tool.

The web page and the MCP server both talk to the same local API (MCP is served by the API at `/mcp`; `packages/mcp`
also runs over stdio). Neither holds bounty funds or a key that can move them.

## Stack

| Layer | Tech |
|---|---|
| Creator web page | Next.js (App Router), TypeScript, Tailwind, shadcn/ui |
| Developer interface | Claude Code / any MCP client → MCP TypeScript SDK (Streamable HTTP at `/mcp`, or stdio) |
| Security reviewer | TypeScript in `packages/agents`, loaded by the runner via `SECURITY_REVIEWER_MODULE` |
| Contracts | Solidity, Foundry, OpenZeppelin |
| Chain access | viem |
| Network | Arc testnet (or any EVM testnet); local Anvil as fallback |
| Token | Testnet USDC or a mock ERC-20 |
| Sandbox | Docker |
| Database | SQLite |
| Tests | Foundry (`forge test`), Vitest |

Use TypeScript everywhere except contracts. Share types between the MCP server, the API, and the frontend instead of duplicating them.

## Layout

```
apps/web/          Minimal creator page (post, fund, accept)
apps/api/          Local API: index, chain relayer, SSE, and MCP over HTTP at /mcp
packages/mcp/      MCP tools (served by the API; stdio entry for other clients)
packages/runner/   Sandbox runner process: Docker (default) or process fallback, signs receipts
packages/agents/   Security reviewer (SECURITY_REVIEWER_MODULE) and scripted demo/adversarial MCP clients (`pnpm demo:agents`)
.claude/commands/  Claude Code setup assets: /solve-bounty
packages/shared/   Shared types, EIP-712 schemas, contract ABIs (`@abm/shared/abi`)
contracts/         Foundry project (src/, test/, script/)
demo/              Fixture submissions used by `pnpm demo` and the end-to-end test
scripts/demo.mjs   One-command local demo
```

Keep this layout unless the team agrees to change it. If you add a package, update this file.

## Contract rules

- The contract is the **only payout authority**. Nothing off-chain can move bounty funds.
- Workflow states:
  `BOUNTY_CREATED → CODE_SUBMITTED → BUILD_VERIFIED → TESTS_VERIFIED → SECURITY_REVIEWED → CREATOR_ACCEPTED → PAYOUT`.
  The contract must reject any skipped or out-of-order transition.
- Receipts use **EIP-712** typed signatures. Each receipt binds `bountyId`, `submissionId`, `commitHash`, `receiptType`, `runnerVersion`, `result`, `timestamp`, and `expiry`.
- Enforce replay protection, signer allowlists, deadlines, and refunds.
- Store hashes and settlement state onchain. Never store code or logs onchain.
- Use OpenZeppelin for ERC-20 handling, access control, ECDSA/EIP-712, and `ReentrancyGuard`. Don't write your own crypto.
- Start with one contract. Split it into Registry, Verifier, and Settlement only if that makes the code clearer.
- Every revert path needs a Foundry test. Required negative tests:
  - Wrong commit
  - Reused receipt
  - Skipped state
  - Expired receipt
  - Unapproved signer
  - Double payout

## MCP server rules

Expose only narrow tools:

```
list_bounties  get_bounty_spec  download_repository  submit_code
get_submission_status  request_test_run  request_security_review
```

**Never** expose tools that send transactions, withdraw or modify bounties, or give access to keys. Validate every input. An agent is untrusted input.

## Sandbox rules

Submitted code is hostile. The runner must use:

- No network access unless the bounty explicitly allows it
- No host filesystem access
- No secrets or env passthrough
- CPU, memory, and time limits
- A fixed repository snapshot and a fixed test command from the locked bounty spec

The signing key lives only in the runner process, outside the container.

The runner picks its backend from `RUNNER_BACKEND`: `docker` (default; fails if `docker info` fails) or `process`.
`process` runs submissions as **unsandboxed host processes** and is for local demos only; it prints a loud warning.
`pnpm demo` uses Docker whenever `docker info` works. Snapshots are staged under `ABM_SANDBOX_DIR`
(default `~/.abm/sandbox`), because Colima and Docker Desktop only share the home directory with the VM.

The API relays receipts onchain with `RELAYER_PRIVATE_KEY`. That key holds no contract role and can only call the
permissionless `submitCode` / `submitReceipt`; payout requires the creator's own wallet.

## Secrets

- Keep private keys and API keys in `.env.local`. It is gitignored. Never commit it.
- Commit `.env.example` with placeholder values.
- Only use testnet keys. Never put a mainnet key anywhere in this repo.

## Commands

pnpm is pinned through `packageManager`. If `pnpm` isn't on PATH, run `corepack enable` once or prefix commands with `corepack`.

```
pnpm install
pnpm demo                # Anvil + deploy + seed + runner + API (:4000, MCP at /mcp) + web (:3000)
pnpm demo:agents         # against a running demo: honest agent, rigged agent, attacks (`attack` after payout)
pnpm dev                 # api + web only (bring your own chain/runner env)
pnpm test                # vitest across all packages (e2e runs when anvil + forge are on PATH)
pnpm typecheck           # tsc in every package
pnpm --filter @abm/web build
pnpm --filter @abm/runner start   # runner process (needs .env.local)
cd contracts && forge build && forge test   # see contracts/README.md for setup
```

`pnpm demo` writes `.env.local` (gitignored) with Anvil's public dev keys and the deployed addresses. Foundry is
expected in `~/.foundry/bin`.

Workspace packages are named `@abm/<dir>` and import shared types from `@abm/shared`. Copy `.env.example` to `.env.local`.

## Working conventions

- Use pnpm workspaces.
- Use strict TypeScript. No `any` without a comment explaining why.
- Make small, focused commits with imperative messages.
- Run `forge test` and `pnpm test` before you say a change is done.
- For web changes, screenshot the page and check it before you hand it back. For MCP changes, call the tools from a real MCP client (Claude Code or the SDK client) against `pnpm demo` and read the output.
- MCP tool output: plain JSON an agent can act on. Always include the workflow state, a one-line `nextStep`, and the failing output from the last run. Never return secrets or anything that could move funds.
- Write UI copy that is short and specific. No marketing filler.
- If a choice would cost demo reliability, choose the reliable option. A working local-chain demo beats a flaky testnet one.

## Out of scope for the MVP

- Multi-chain support
- Arbitrary test frameworks
- Autonomous agent wallets
- Onchain code storage
- ZK proofs
- Reputation systems
- Production-grade execution
- Picking the winner automatically with an AI judge

If a task pulls toward any of these, stop and ask the team first.
