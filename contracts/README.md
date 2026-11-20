# Contracts

Foundry project for `BountyEscrow` (the only payout authority) and `MockUSDC` (6-decimal test token).

## Setup

No sudo needed. Foundry installs to `~/.foundry/bin`.

```
curl -L https://foundry.paradigm.xyz | bash
~/.foundry/bin/foundryup          # add ~/.foundry/bin to PATH
cd contracts
forge install foundry-rs/forge-std@v1.11.0 OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge build && forge test
```

`lib/` is gitignored; run the `forge install` line after cloning. `forge test -vvv` shows traces.

## Local deploy (Anvil)

```
anvil                                                    # terminal 1, chain id 31337
cd contracts                                             # terminal 2
RUNNER_SIGNER_PRIVATE_KEY=<runner key> \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # Anvil account 0
```

The script deploys `MockUSDC` and `BountyEscrow`, grants `RUNNER_ROLE` and `REVIEWER_ROLE` to the runner
signer, and mints 1,000,000 mock USDC to the deployer. It prints `USDC_ADDRESS` and
`BOUNTY_CONTRACT_ADDRESS` for `.env.local`. On a fresh Anvil with account 0 these are always
`0x5FbDB2315678afecb367f032d93F642f64180aa3` and `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`.

Optional env: `RUNNER_SIGNER_ADDRESS` (instead of the key), `REVIEWER_SIGNER_ADDRESS` (separate security
reviewer), `MINT_TO` (extra address to fund, e.g. the creator's wallet). Only the derived address is used;
the runner key is never broadcast.

## ABI for TypeScript

```
./script/export-abi.sh   # writes packages/shared/src/abi/{bountyEscrow,mockUsdc}.ts
```

Re-run after any change to the contract interface. The EIP-712 domain and types live in
`packages/shared/src/eip712.ts`.

## How it works

| Step | Call | Who | Check |
|---|---|---|---|
| `BOUNTY_CREATED` | `createBounty(specHash, testSuiteHash, amount, deadline)` | creator | pulls `amount` (approve first); hashes locked |
| `CODE_SUBMITTED` | `submitCode(bountyId, commitHash, submitter)` | anyone (API) | bounty open, before deadline |
| `BUILD_VERIFIED` | `submitReceipt(receipt, sig)` type 0 | anyone relays | `RUNNER_ROLE` signature |
| `TESTS_VERIFIED` | `submitReceipt(receipt, sig)` type 1 | anyone relays | `RUNNER_ROLE` signature |
| `SECURITY_REVIEWED` | `submitReceipt(receipt, sig)` type 2 | anyone relays | `REVIEWER_ROLE` signature |
| `CREATOR_ACCEPTED` → `PAYOUT` | `acceptSubmission(submissionId)` | creator only | pays `submitter` in the same tx |
| refund | `refund(bountyId)` | creator only | after deadline, not awarded |

Every receipt must: be signed by an allowlisted signer for its type, match the submission's `bountyId` and
`commitHash`, have `result = true`, `timestamp <= now <= expiry`, not have been used before, and move the
submission exactly one state forward. Each step is one state; anything skipped or out of order reverts
with `InvalidTransition(from, to)`.

`commitHash` is the git commit id as bytes32, SHA-1 ids left-padded with zeros
(`commitHashToBytes32` in `@abm/shared`). Admin manages signers with `grantRole` / `revokeRole`.
