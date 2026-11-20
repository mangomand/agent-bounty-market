// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Local Anvil deploy: MockUSDC + BountyEscrow, with the runner signer allowlisted.
/// Env:
///   RUNNER_SIGNER_ADDRESS      signer for build/test/security receipts, or
///   RUNNER_SIGNER_PRIVATE_KEY  (address is derived from it; the key is never broadcast)
///   REVIEWER_SIGNER_ADDRESS    optional separate security reviewer (defaults to the runner)
///   MINT_TO                    optional extra address to receive 1,000,000 mock USDC
contract Deploy is Script {
    uint256 constant MINT_AMOUNT = 1_000_000e6;

    function run() external returns (MockUSDC usdc, BountyEscrow escrow) {
        address runner = vm.envOr("RUNNER_SIGNER_ADDRESS", address(0));
        if (runner == address(0)) runner = vm.addr(vm.envUint("RUNNER_SIGNER_PRIVATE_KEY"));
        address reviewer = vm.envOr("REVIEWER_SIGNER_ADDRESS", runner);
        address mintTo = vm.envOr("MINT_TO", address(0));

        vm.startBroadcast();
        address deployer = msg.sender;

        usdc = new MockUSDC();
        escrow = new BountyEscrow(IERC20(address(usdc)), deployer);
        escrow.grantRole(escrow.RUNNER_ROLE(), runner);
        escrow.grantRole(escrow.REVIEWER_ROLE(), reviewer);

        usdc.mint(deployer, MINT_AMOUNT);
        if (mintTo != address(0)) usdc.mint(mintTo, MINT_AMOUNT);
        vm.stopBroadcast();

        console.log("USDC_ADDRESS=%s", address(usdc));
        console.log("BOUNTY_CONTRACT_ADDRESS=%s", address(escrow));
        console.log("runner signer: %s", runner);
        console.log("reviewer signer: %s", reviewer);
    }
}
