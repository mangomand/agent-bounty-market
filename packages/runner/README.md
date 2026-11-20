# @abm/runner

Builds and tests submissions in a sandbox and signs EIP-712 receipts. It runs as its own process and is the only place the signing keys live.

```sh
corepack pnpm --filter @abm/runner start   # http://127.0.0.1:4100, reads ../../.env.local
```

The API sends `POST /run` with a `RunJob`:

- `test`: runs `npm run build --if-present`, then the bounty's fixed test command. Returns signed `BuildReceipt` and `TestReceipt` (the test receipt is skipped if the build fails), plus a log tail.
- `security`: runs the security reviewer over the source (never executes it) and returns a signed `SecurityReviewReceipt` from the reviewer key.

| Env | Default | |
|---|---|---|
| `RUNNER_BACKEND` | `docker` | `docker` fails fast if `docker info` fails. `process` runs code as **unsandboxed host processes** (local demos only) and prints a warning |
| `ABM_SANDBOX_DIR` | `~/.abm/sandbox` | Per-run snapshot copies, bind-mounted read-only. Must be shared with the Docker VM (Colima and Docker Desktop share only `$HOME` by default). Removed after each run |
| `RUNNER_SIGNER_PRIVATE_KEY` | required | `RUNNER_ROLE` key for build/test receipts |
| `REVIEWER_SIGNER_PRIVATE_KEY` | runner key | `REVIEWER_ROLE` key for security receipts |
| `BOUNTY_CONTRACT_ADDRESS`, `CHAIN_ID` | required, `31337` | EIP-712 domain |
| `SECURITY_REVIEWER_MODULE` | built-in static scan | Module whose default export implements `SecurityReviewer` (`src/security.ts`) |

Docker sandbox: `--network none`, non-root (`65534`), read-only root fs, tmpfs workspace, `--cap-drop ALL`, `no-new-privileges`, CPU/memory/pid limits, no env passthrough. `src/docker.integration.test.ts` checks this against a live daemon when one is available.

Receipts record the backend in `runnerVersion` (`abm-runner-0.1.0+docker`), so a receipt from the process fallback is visible as such.
