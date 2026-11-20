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
- **Developer CLI** (`apps/cli`): for devs running agents. This is the showpiece and should look polished in a terminal:
  - Browse bounties
  - Start or attach an agent
  - Watch submissions move through the workflow live
  - View receipts and payout status

  Commands look like `bounty list`, `bounty run <id>`, `bounty watch <id>`, and `bounty receipts <id>`.

Both talk to the same local API. Neither holds bounty funds or a key that can move them.

## Stack

| Layer | Tech |
|---|---|
| Creator web page | Next.js (App Router), TypeScript, Tailwind, shadcn/ui |
| Developer CLI | TypeScript, Ink (React for terminals), commander |
| Agent interface | MCP TypeScript SDK |
| Agent runtime | TypeScript + an LLM SDK |
| Contracts | Solidity, Foundry, OpenZeppelin |
| Chain access | viem |
| Network | Arc testnet (or any EVM testnet); local Anvil as fallback |
| Token | Testnet USDC or a mock ERC-20 |
| Sandbox | Docker |
| Database | SQLite |
| Tests | Foundry (`forge test`), Vitest |

Use TypeScript everywhere except contracts. Share types between the MCP server, the API, and the frontend instead of duplicating them.

## Planned layout

```
apps/web/          Minimal creator page (post, fund, accept)
apps/cli/          Developer CLI (Ink TUI)
apps/api/          Local API shared by web, CLI, and MCP server
packages/mcp/      MCP server (bounty discovery + submission tools)
packages/runner/   Docker sandbox runner + receipt signing
packages/agents/   Demo coding agents (fast/careless, test-focused, security-focused)
packages/shared/   Shared types, EIP-712 schemas, contract ABIs
contracts/         Foundry project (src/, test/, script/)
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

## Secrets

- Keep private keys and API keys in `.env.local`. It is gitignored. Never commit it.
- Commit `.env.example` with placeholder values.
- Only use testnet keys. Never put a mainnet key anywhere in this repo.

## Commands (fill in as they're created)

```
pnpm install
pnpm dev                 # web + api
pnpm test                # vitest
cd contracts && forge build && forge test
anvil                    # local chain fallback
```

## Working conventions

- Use pnpm workspaces.
- Use strict TypeScript. No `any` without a comment explaining why.
- Make small, focused commits with imperative messages.
- Run `forge test` and `pnpm test` before you say a change is done.
- For web changes, screenshot the page and check it before you hand it back. For CLI changes, run the command and check the terminal output, including at a narrow width.
- CLI style: use color with meaning (green = verified, red = rejected, yellow = pending). Show spinners for live steps and a clear workflow progress line. It must still be readable with `NO_COLOR` set.
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
