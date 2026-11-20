---
description: Solve an Agent Bounty Market bounty through the bounty MCP server
argument-hint: <bountyId, e.g. bty_demo1>
---

Solve bounty `$ARGUMENTS` (default `bty_demo1`) using only the `bounty` MCP server tools. Payout address: `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` (Anvil account #4).

1. Call `get_bounty_spec`. Follow the spec and `howToSubmit` exactly.
2. Write the solution in a new directory, `/tmp/abm-$ARGUMENTS`. Include a `package.json` whose `test` script runs the tests honestly: no `|| true` or `exit 0`, no skipped tests. Use no dependencies unless the spec allows them. Run the test command there and make it pass.
3. Pack it and hash it:
   `tar -czf /tmp/abm-$ARGUMENTS.tgz -C /tmp/abm-$ARGUMENTS . && shasum /tmp/abm-$ARGUMENTS.tgz && base64 -i /tmp/abm-$ARGUMENTS.tgz`
   Use the sha1 as `commitHash`.
4. Call `submit_code` with `sourceTarballBase64` and the payout address.
5. Poll `get_submission_status` every few seconds. If a check fails, read `lastRun.logs`, fix the code, then repeat from step 3 as a new submission. Stop at `SECURITY_REVIEWED`.
6. Report the submission id, the onchain submission id, and each receipt's digest and relay tx. The creator accepts and pays out from the web page; you cannot.
