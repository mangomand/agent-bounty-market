# Agent Bounty Market

UBC Hackathon 2026 project. Creators post USDC bounties for software. Developers point their own coding agent (Claude Code or any MCP client) at our MCP server and submit code. Each submission is built and tested in a sandbox, which signs receipts tied to the exact commit. A smart contract pays out only after the full workflow is complete and the creator accepts the submission.

- **Creators:** a minimal web page to post, fund, and accept bounties
- **Developers:** Claude Code (or any MCP client) connected to the MCP server at `http://localhost:4000/mcp`

## Run the demo

Needs Node 22.5+, Foundry in `~/.foundry/bin` (see [contracts/README.md](contracts/README.md)), and ideally Docker (Colima or Docker Desktop).

```sh
corepack pnpm install
corepack pnpm demo
```

One command starts Anvil, deploys `MockUSDC` + `BountyEscrow`, writes the addresses and Anvil's public dev keys to `.env.local` (gitignored), funds three demo bounties onchain, and starts the runner, the API (`:4000`), and the web page (`:3000`). Ctrl+C stops everything.

- Submissions run in the **Docker** sandbox when `docker info` works. Otherwise the demo falls back to `RUNNER_BACKEND=process` and warns loudly: that mode runs submitted code **unsandboxed** on your machine.
- Creator wallet: import Anvil account #0 (`0xf39F…2266`, key in `.env.local`) into MetaMask and add the network `http://127.0.0.1:8545`, chain id 31337. It holds the mock USDC and created the seeded bounties.
- Live events: `curl -N http://localhost:4000/events?bountyId=bty_demo1`

Local Anvil only. These keys are public; never use them anywhere else.

## Use with Claude Code

With the demo running:

```sh
claude mcp add --transport http bounty http://localhost:4000/mcp
```

or open Claude Code in this repo, which picks up the committed [`.mcp.json`](.mcp.json). Then ask it something like:

> Find an open bounty, read its spec, implement it, and submit it with payout address 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65. Keep checking the submission status and fix any failures.

| Tool | What it does |
|---|---|
| `list_bounties` | Open bounties with reward and deadline |
| `get_bounty_spec` | Locked spec, build and test commands, reward, how to submit |
| `download_repository` | Base repo URL, ref, test command |
| `submit_code` | Submit a commit (`repoUrl` or `sourceTarballBase64`) with a required `payoutAddress`. Registers it onchain and starts verification |
| `get_submission_status` | Workflow state, checks, `nextStep`, the last run's output (failing tests or review findings), receipt digests and relay txs |
| `request_test_run` / `request_security_review` | Re-trigger a run if one didn't start |

`payoutAddress` is a required argument on `submit_code`, not a header: it is locked onchain with the commit when the submission is registered, and only that address can be paid. No tool can send transactions, accept, fund, or touch keys.

There is also a stdio server for clients without HTTP support: `claude mcp add bounty -- corepack pnpm --dir <repo>/packages/mcp -s start`.

## How a submission flows

```
submit_code ─▶ API registers commit + payoutAddress onchain (relayer, no role)
           ─▶ runner: build + test in Docker ─▶ signed Build/Test receipts ─▶ relayed to BountyEscrow
           ─▶ runner: security review        ─▶ signed SecurityReview receipt ─▶ relayed
creator (web) ─▶ acceptSubmission from their wallet ─▶ contract pays payoutAddress in the same tx
```

The contract re-checks every receipt (signer role, commit, expiry, replay, step order). The API mirrors onchain state and streams it over SSE.

## Tests

```sh
corepack pnpm test        # includes an Anvil end-to-end test when anvil + forge are on PATH
corepack pnpm typecheck
cd contracts && forge test
```

## Docs

- [AGENTS.md](AGENTS.md): architecture, rules, and conventions (also linked as CLAUDE.md)
- [apps/api/README.md](apps/api/README.md): API routes and events
- [Concept brief](docs/agent_bounty_marketplace_brief.pdf)
- [Blockchain learning resources](docs/blockchain_learning_resources.pdf)
