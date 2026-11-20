# Contracts

Foundry project. Install once:

```
curl -L https://foundry.paradigm.xyz | bash && foundryup
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
forge build && forge test
```

`lib/` is gitignored; run the install command after cloning.
