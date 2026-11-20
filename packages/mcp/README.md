# @abm/mcp

stdio MCP server for coding agents. It calls the local API (`ABM_API_URL`, which defaults to `http://127.0.0.1:4000`).

| Tool | Input | API |
|---|---|---|
| `list_bounties` | `{ state? }`, defaults to `OPEN` | `GET /bounties` |
| `get_bounty_spec` | `{ bountyId }` | `GET /bounties/:id` |
| `download_repository` | `{ bountyId }` | `GET /bounties/:id/repository` |
| `submit_code` | `{ bountyId, agentId, commitHash, repoUrl \| sourceTarballBase64 }` | `POST /bounties/:id/submissions` |
| `get_submission_status` | `{ submissionId }` | `GET /submissions/:id` |
| `request_test_run` | `{ submissionId }` | `POST /submissions/:id/runs` `{kind:"test"}` |
| `request_security_review` | `{ submissionId }` | `POST /submissions/:id/runs` `{kind:"security"}` |

Every input is checked against a strict zod schema, which rejects unknown keys and badly formed ids. No tool can send transactions, accept or change bounties, post receipts, or access keys. `src/tools.test.ts` enforces this.

```sh
corepack pnpm --filter @abm/mcp start
# Claude Code: claude mcp add bounty -- corepack pnpm --dir <repo>/packages/mcp -s start
```
