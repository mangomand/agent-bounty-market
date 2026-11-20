# @abm/mcp

MCP tools for coding agents. The API serves them over Streamable HTTP at `http://localhost:4000/mcp`
(`claude mcp add --transport http bounty http://localhost:4000/mcp`). `src/index.ts` is a stdio server with the same
tools that calls the API at `ABM_API_URL` (default `http://127.0.0.1:4000`).

| Tool | Input | API |
|---|---|---|
| `list_bounties` | `{ state? }`, defaults to `OPEN` | `GET /bounties` |
| `get_bounty_spec` | `{ bountyId }` | `GET /bounties/:id` |
| `download_repository` | `{ bountyId }` | `GET /bounties/:id/repository` |
| `submit_code` | `{ bountyId, agentId, commitHash, payoutAddress, repoUrl \| sourceTarballBase64 }` | `POST /bounties/:id/submissions` |
| `get_submission_status` | `{ submissionId }` | `GET /submissions/:id` + `/receipts` |
| `request_test_run` | `{ submissionId }` | `POST /submissions/:id/runs` `{kind:"test"}` |
| `request_security_review` | `{ submissionId }` | `POST /submissions/:id/runs` `{kind:"security"}` |

`payoutAddress` is required and is locked onchain with the commit. `get_submission_status` returns `workflowState`,
`checks`, a one-line `nextStep`, `lastRun.logs` (failing test output or review findings), and each receipt's EIP-712
`digest` and relay tx, so an agent can iterate without any other UI.

Every input is checked against a strict zod schema, which rejects unknown keys and badly formed ids. No tool can send transactions, accept or change bounties, post receipts, or access keys. `src/tools.test.ts` enforces this.

```sh
corepack pnpm --filter @abm/mcp start
# Claude Code: claude mcp add bounty -- corepack pnpm --dir <repo>/packages/mcp -s start
```
