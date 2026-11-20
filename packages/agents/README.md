# @abm/agents

Developers bring their own Claude Code. This package holds what goes around it:

- **Claude Code setup** (`claude-code/`): `.mcp.json` and the `bounty-hunter` skill.
- **Security reviewer**: static checks, an LLM review, and an EIP-712 `SecurityReviewReceipt`.
- **Scripted demo clients**: `adversarial` and `broken`, with no LLM, used only through the public MCP tools.

## Claude Code

```sh
cp packages/agents/claude-code/.mcp.json <your-project>/
mkdir -p <your-project>/.claude/skills && cp -r packages/agents/claude-code/skills/bounty-hunter <your-project>/.claude/skills/
# or: claude mcp add --transport http bounty http://localhost:4000/mcp
```

Then ask Claude Code to "work on bounty bty_demo1, pay out to 0x…".

## Demo clients

```sh
corepack pnpm --filter @abm/agents start -- adversarial --bounty bty_demo1
corepack pnpm --filter @abm/agents start -- broken --bounty bty_demo1 [--wait 120]
```

`adversarial` submits a commit, then tries to:

1. request a security review before tests,
2. call `accept_submission` and `submit_receipt`, which the server doesn't expose,
3. run tests twice on the same commit,
4. submit a second commit and go straight to security review on the first commit's test run.

Every step after a submission should be rejected. `broken` submits a `slugify` that returns its input, requests a test run, and waits for the failed result. Both exit 0 when everything behaves as expected and 2 when it doesn't. The MCP URL defaults to `$ABM_MCP_URL` or `http://localhost:4000/mcp`. `--payout` is sent as `payoutAddress` only when given.

## Security reviewer

```ts
import { reviewAndSign, securityReviewRunner, AnthropicLlm } from "@abm/agents";

// A RunnerClient for `kind: "security"` jobs: fetch source, review, sign one receipt.
const runner = securityReviewRunner({
  signing: { chainId, verifyingContract: escrowAddress },
  llm: new AnthropicLlm(),            // ANTHROPIC_API_KEY; default model claude-sonnet-5-5
  onchainIds: (job) => ({ bountyId: job.bounty.onchainId!, submissionId: lookupOnchainSubId(job) }),
});
const { receipts } = await runner.run(job); // receipts[0] is POST /submissions/:id/receipts shaped
```

- `reviewSource(files, { llm?, spec?, failOn? })` returns `{ pass, findings, summary }`. Static checks cover network, env/secrets, eval/`vm`, `child_process`, filesystem escapes, symlinks, and `process.exit`/`kill`. A high-severity finding, an LLM `pass: false`, or an unusable LLM reply fails the review.
- `signSecurityReview(input, ctx, account?)` signs with `REVIEWER_SIGNER_PRIVATE_KEY` using `receiptTypes`/`receiptDomain` from `@abm/shared`. It returns the signed `message` (onchain uint ids) and an `apiReceipt` (API ids).
- `recoverSecurityReviewSigner(signed, ctx)` recovers the signer address.
- `corepack pnpm --filter @abm/agents start -- review --dir <path> [--no-llm]` prints findings.

Tests use `FakeLlm`; nothing calls the API without a key.
