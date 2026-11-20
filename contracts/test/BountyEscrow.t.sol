// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @dev Calls back into the escrow during a token transfer to prove nonReentrant holds.
contract ReentrantToken is MockUSDC {
    BountyEscrow public target;
    uint256 public submissionId;
    bool public armed;

    function arm(BountyEscrow t, uint256 id) external {
        target = t;
        submissionId = id;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            target.acceptSubmission(submissionId);
        }
        return super.transfer(to, amount);
    }
}

contract BountyEscrowTest is Test {
    BountyEscrow escrow;
    MockUSDC usdc;

    address admin = makeAddr("admin");
    address creator = makeAddr("creator");
    address agent = makeAddr("agent");
    address relayer = makeAddr("relayer");

    uint256 runnerKey = 0xA11CE;
    uint256 reviewerKey = 0xB0B;
    uint256 strangerKey = 0xBAD;
    address runner;
    address reviewer;

    uint256 constant AMOUNT = 500e6;
    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant SUITE = keccak256("suite");
    bytes32 constant COMMIT = bytes32(uint256(0xc0ffee));
    string constant RUNNER_VERSION = "runner/0.1.0";
    uint64 deadline;

    function setUp() public {
        vm.warp(1_800_000_000);
        runner = vm.addr(runnerKey);
        reviewer = vm.addr(reviewerKey);

        usdc = new MockUSDC();
        escrow = new BountyEscrow(IERC20(address(usdc)), admin);

        vm.startPrank(admin);
        escrow.grantRole(escrow.RUNNER_ROLE(), runner);
        escrow.grantRole(escrow.REVIEWER_ROLE(), reviewer);
        vm.stopPrank();

        usdc.mint(creator, 10_000e6);
        vm.prank(creator);
        usdc.approve(address(escrow), type(uint256).max);
        deadline = uint64(block.timestamp + 7 days);
    }

    // ---------------------------------------------------------------- helpers

    function _createBounty() internal returns (uint256) {
        vm.prank(creator);
        return escrow.createBounty(SPEC, SUITE, AMOUNT, deadline);
    }

    function _submit(uint256 bountyId) internal returns (uint256) {
        vm.prank(relayer);
        return escrow.submitCode(bountyId, COMMIT, agent);
    }

    function _receipt(uint256 bountyId, uint256 submissionId, BountyEscrow.ReceiptType t)
        internal
        view
        returns (BountyEscrow.Receipt memory)
    {
        return BountyEscrow.Receipt({
            bountyId: bountyId,
            submissionId: submissionId,
            commitHash: COMMIT,
            receiptType: uint8(t),
            runnerVersion: RUNNER_VERSION,
            result: true,
            timestamp: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 1 hours)
        });
    }

    function _sign(uint256 key, BountyEscrow.Receipt memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, escrow.hashReceipt(r));
        return abi.encodePacked(rr, s, v);
    }

    function _keyFor(BountyEscrow.ReceiptType t) internal view returns (uint256) {
        return t == BountyEscrow.ReceiptType.SecurityReview ? reviewerKey : runnerKey;
    }

    function _attest(uint256 bountyId, uint256 submissionId, BountyEscrow.ReceiptType t) internal {
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, t);
        escrow.submitReceipt(r, _sign(_keyFor(t), r));
    }

    function _fullyReviewed() internal returns (uint256 bountyId, uint256 submissionId) {
        bountyId = _createBounty();
        submissionId = _submit(bountyId);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Test);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.SecurityReview);
    }

    function _state(uint256 submissionId) internal view returns (BountyEscrow.WorkflowState) {
        return escrow.getSubmission(submissionId).state;
    }

    // ---------------------------------------------------------------- happy path

    function test_HappyPath_PaysSubmitter() public {
        uint256 bountyId = _createBounty();
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        uint256 submissionId = _submit(bountyId);
        assertEq(uint8(_state(submissionId)), uint8(BountyEscrow.WorkflowState.CodeSubmitted));

        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        assertEq(uint8(_state(submissionId)), uint8(BountyEscrow.WorkflowState.BuildVerified));
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Test);
        assertEq(uint8(_state(submissionId)), uint8(BountyEscrow.WorkflowState.TestsVerified));
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.SecurityReview);
        assertEq(uint8(_state(submissionId)), uint8(BountyEscrow.WorkflowState.SecurityReviewed));

        vm.expectEmit(address(escrow));
        emit BountyEscrow.PayoutReleased(bountyId, submissionId, agent, AMOUNT);
        vm.prank(creator);
        escrow.acceptSubmission(submissionId);

        assertEq(uint8(_state(submissionId)), uint8(BountyEscrow.WorkflowState.Payout));
        assertEq(usdc.balanceOf(agent), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);
        assertEq(uint8(b.status), uint8(BountyEscrow.BountyStatus.Awarded));
        assertEq(b.awardedSubmissionId, submissionId);

        BountyEscrow.Submission memory s = escrow.getSubmission(submissionId);
        assertTrue(s.buildReceipt != bytes32(0) && s.testReceipt != bytes32(0) && s.securityReceipt != bytes32(0));
    }

    function test_CreateBounty_StoresLockedSpec() public {
        uint256 bountyId = _createBounty();
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);
        assertEq(b.creator, creator);
        assertEq(b.amount, AMOUNT);
        assertEq(b.specHash, SPEC);
        assertEq(b.testSuiteHash, SUITE);
        assertEq(b.deadline, deadline);
        assertEq(uint8(b.status), uint8(BountyEscrow.BountyStatus.Open));
    }

    function test_Refund_AfterDeadline() public {
        uint256 bountyId = _createBounty();
        vm.warp(deadline + 1);
        uint256 before = usdc.balanceOf(creator);
        vm.prank(creator);
        escrow.refund(bountyId);
        assertEq(usdc.balanceOf(creator), before + AMOUNT);
        assertEq(uint8(escrow.getBounty(bountyId).status), uint8(BountyEscrow.BountyStatus.Refunded));
    }

    /// @dev The receipt digest must equal the standard EIP-712 hash that viem's signTypedData
    ///      computes from the types in packages/shared/src/eip712.ts.
    function test_HashReceipt_MatchesStandardEip712() public view {
        BountyEscrow.Receipt memory r = BountyEscrow.Receipt({
            bountyId: 1,
            submissionId: 2,
            commitHash: COMMIT,
            receiptType: uint8(BountyEscrow.ReceiptType.Test),
            runnerVersion: RUNNER_VERSION,
            result: true,
            timestamp: 1_800_000_000,
            expiry: 1_800_003_600
        });
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"TestReceipt":[{"name":"bountyId","type":"uint256"},{"name":"submissionId","type":"uint256"},',
            '{"name":"commitHash","type":"bytes32"},{"name":"receiptType","type":"uint8"},',
            '{"name":"runnerVersion","type":"string"},{"name":"result","type":"bool"},',
            '{"name":"timestamp","type":"uint64"},{"name":"expiry","type":"uint64"}]},',
            '"primaryType":"TestReceipt",',
            '"domain":{"name":"AgentBountyMarket","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(escrow)),
            '"},"message":{"bountyId":1,"submissionId":2,"commitHash":"',
            vm.toString(COMMIT),
            '","receiptType":1,"runnerVersion":"runner/0.1.0","result":true,',
            '"timestamp":1800000000,"expiry":1800003600}}'
        );
        assertEq(escrow.hashReceipt(r), vm.eip712HashTypedData(json));
    }

    // ---------------------------------------------------------------- required negative tests

    function test_RevertWhen_WrongCommit() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        r.commitHash = bytes32(uint256(0xdead));
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(BountyEscrow.WrongCommit.selector);
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_ReceiptReused() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(runnerKey, r);
        escrow.submitReceipt(r, sig);
        bytes32 digest = escrow.hashReceipt(r);
        assertTrue(escrow.receiptUsed(digest));
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.ReceiptAlreadyUsed.selector, digest));
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_TestsBeforeBuild() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Test);
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(
            abi.encodeWithSelector(
                BountyEscrow.InvalidTransition.selector,
                BountyEscrow.WorkflowState.CodeSubmitted,
                BountyEscrow.WorkflowState.TestsVerified
            )
        );
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_SecurityBeforeTests() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.SecurityReview);
        bytes memory sig = _sign(reviewerKey, r);
        vm.expectRevert(
            abi.encodeWithSelector(
                BountyEscrow.InvalidTransition.selector,
                BountyEscrow.WorkflowState.BuildVerified,
                BountyEscrow.WorkflowState.SecurityReviewed
            )
        );
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_AcceptBeforeSecurityReview() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Test);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                BountyEscrow.InvalidTransition.selector,
                BountyEscrow.WorkflowState.TestsVerified,
                BountyEscrow.WorkflowState.CreatorAccepted
            )
        );
        escrow.acceptSubmission(submissionId);
    }

    function test_RevertWhen_AcceptWithNoReceipts() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                BountyEscrow.InvalidTransition.selector,
                BountyEscrow.WorkflowState.CodeSubmitted,
                BountyEscrow.WorkflowState.CreatorAccepted
            )
        );
        escrow.acceptSubmission(submissionId);
    }

    function test_RevertWhen_BuildReceiptReplayedAfterTests() public {
        // A fresh (unused) build receipt cannot move a submission backwards.
        (uint256 bountyId, uint256 submissionId) = _fullyReviewed();
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        r.expiry += 1; // distinct digest
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(
            abi.encodeWithSelector(
                BountyEscrow.InvalidTransition.selector,
                BountyEscrow.WorkflowState.SecurityReviewed,
                BountyEscrow.WorkflowState.BuildVerified
            )
        );
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_ReceiptExpired() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(runnerKey, r);
        vm.warp(r.expiry + 1);
        vm.expectRevert(BountyEscrow.ReceiptExpired.selector);
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_UnapprovedSigner() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(strangerKey, r);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnapprovedSigner.selector, vm.addr(strangerKey)));
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_RunnerSignsSecurityReview() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Test);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.SecurityReview);
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnapprovedSigner.selector, runner));
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_SignerRevoked() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        bytes32 role = escrow.RUNNER_ROLE();
        vm.prank(admin);
        escrow.revokeRole(role, runner);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.UnapprovedSigner.selector, runner));
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_DoublePayout_SameSubmission() public {
        (, uint256 submissionId) = _fullyReviewed();
        vm.startPrank(creator);
        escrow.acceptSubmission(submissionId);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotOpen.selector, 1));
        escrow.acceptSubmission(submissionId);
        vm.stopPrank();
        assertEq(usdc.balanceOf(agent), AMOUNT);
    }

    function test_RevertWhen_DoublePayout_SecondSubmission() public {
        (uint256 bountyId, uint256 first) = _fullyReviewed();
        uint256 second = _submit(bountyId);
        _attest(bountyId, second, BountyEscrow.ReceiptType.Build);
        _attest(bountyId, second, BountyEscrow.ReceiptType.Test);
        _attest(bountyId, second, BountyEscrow.ReceiptType.SecurityReview);

        vm.startPrank(creator);
        escrow.acceptSubmission(first);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotOpen.selector, bountyId));
        escrow.acceptSubmission(second);
        vm.stopPrank();
    }

    function test_RevertWhen_RefundAfterPayout() public {
        (uint256 bountyId, uint256 submissionId) = _fullyReviewed();
        vm.prank(creator);
        escrow.acceptSubmission(submissionId);
        vm.warp(deadline + 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotOpen.selector, bountyId));
        escrow.refund(bountyId);
    }

    function test_RevertWhen_AcceptAfterRefund() public {
        (uint256 bountyId, uint256 submissionId) = _fullyReviewed();
        vm.warp(deadline + 1);
        vm.startPrank(creator);
        escrow.refund(bountyId);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotOpen.selector, bountyId));
        escrow.acceptSubmission(submissionId);
        vm.stopPrank();
    }

    function test_RevertWhen_Reentrancy() public {
        ReentrantToken bad = new ReentrantToken();
        BountyEscrow e = new BountyEscrow(IERC20(address(bad)), admin);
        vm.startPrank(admin);
        e.grantRole(e.RUNNER_ROLE(), runner);
        e.grantRole(e.REVIEWER_ROLE(), reviewer);
        vm.stopPrank();
        escrow = e; // helpers sign against `escrow`

        bad.mint(creator, AMOUNT);
        vm.prank(creator);
        bad.approve(address(e), AMOUNT);
        (, uint256 submissionId) = _fullyReviewed();
        bad.arm(e, submissionId);

        vm.prank(creator);
        vm.expectRevert(ReentrancyGuardReentrantCall.selector);
        e.acceptSubmission(submissionId);
    }

    error ReentrancyGuardReentrantCall();

    // ---------------------------------------------------------------- other revert paths

    function test_RevertWhen_ConstructorZeroToken() public {
        vm.expectRevert(BountyEscrow.ZeroAddress.selector);
        new BountyEscrow(IERC20(address(0)), admin);
    }

    function test_RevertWhen_ConstructorZeroAdmin() public {
        vm.expectRevert(BountyEscrow.ZeroAddress.selector);
        new BountyEscrow(IERC20(address(usdc)), address(0));
    }

    function test_RevertWhen_CreateZeroAmount() public {
        vm.prank(creator);
        vm.expectRevert(BountyEscrow.ZeroAmount.selector);
        escrow.createBounty(SPEC, SUITE, 0, deadline);
    }

    function test_RevertWhen_CreateZeroSpecHash() public {
        vm.prank(creator);
        vm.expectRevert(BountyEscrow.ZeroHash.selector);
        escrow.createBounty(bytes32(0), SUITE, AMOUNT, deadline);
    }

    function test_RevertWhen_CreateZeroSuiteHash() public {
        vm.prank(creator);
        vm.expectRevert(BountyEscrow.ZeroHash.selector);
        escrow.createBounty(SPEC, bytes32(0), AMOUNT, deadline);
    }

    function test_RevertWhen_CreateDeadlineInPast() public {
        vm.prank(creator);
        vm.expectRevert(BountyEscrow.DeadlineInPast.selector);
        escrow.createBounty(SPEC, SUITE, AMOUNT, uint64(block.timestamp));
    }

    function test_RevertWhen_CreateUnfunded() public {
        address broke = makeAddr("broke");
        vm.startPrank(broke);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert(); // ERC20InsufficientBalance
        escrow.createBounty(SPEC, SUITE, AMOUNT, deadline);
        vm.stopPrank();
    }

    function test_RevertWhen_RefundUnknownBounty() public {
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotFound.selector, 99));
        escrow.refund(99);
    }

    function test_RevertWhen_RefundByNonCreator() public {
        uint256 bountyId = _createBounty();
        vm.warp(deadline + 1);
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.NotCreator.selector);
        escrow.refund(bountyId);
    }

    function test_RevertWhen_RefundBeforeDeadline() public {
        uint256 bountyId = _createBounty();
        vm.warp(deadline);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.DeadlineNotReached.selector, bountyId));
        escrow.refund(bountyId);
    }

    function test_RevertWhen_RefundTwice() public {
        uint256 bountyId = _createBounty();
        vm.warp(deadline + 1);
        vm.startPrank(creator);
        escrow.refund(bountyId);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotOpen.selector, bountyId));
        escrow.refund(bountyId);
        vm.stopPrank();
    }

    function test_RevertWhen_SubmitUnknownBounty() public {
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotFound.selector, 7));
        escrow.submitCode(7, COMMIT, agent);
    }

    function test_RevertWhen_SubmitAfterDeadline() public {
        uint256 bountyId = _createBounty();
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.DeadlinePassed.selector, bountyId));
        escrow.submitCode(bountyId, COMMIT, agent);
    }

    function test_RevertWhen_SubmitZeroCommit() public {
        uint256 bountyId = _createBounty();
        vm.expectRevert(BountyEscrow.ZeroHash.selector);
        escrow.submitCode(bountyId, bytes32(0), agent);
    }

    function test_RevertWhen_SubmitZeroSubmitter() public {
        uint256 bountyId = _createBounty();
        vm.expectRevert(BountyEscrow.ZeroAddress.selector);
        escrow.submitCode(bountyId, COMMIT, address(0));
    }

    function test_RevertWhen_SubmitToRefundedBounty() public {
        uint256 bountyId = _createBounty();
        vm.warp(deadline + 1);
        vm.prank(creator);
        escrow.refund(bountyId);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotOpen.selector, bountyId));
        escrow.submitCode(bountyId, COMMIT, agent);
    }

    function test_RevertWhen_ReceiptForUnknownSubmission() public {
        uint256 bountyId = _createBounty();
        BountyEscrow.Receipt memory r = _receipt(bountyId, 42, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.SubmissionNotFound.selector, 42));
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_ReceiptWrongBounty() public {
        uint256 bountyA = _createBounty();
        uint256 bountyB = _createBounty();
        uint256 submissionId = _submit(bountyA);
        BountyEscrow.Receipt memory r = _receipt(bountyB, submissionId, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(BountyEscrow.WrongBounty.selector);
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_ReceiptOnClosedBounty() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        vm.warp(deadline + 1);
        vm.prank(creator);
        escrow.refund(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.BountyNotOpen.selector, bountyId));
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_InvalidReceiptType() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        r.receiptType = 3;
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.InvalidReceiptType.selector, 3));
        escrow.submitReceipt(r, new bytes(65));
    }

    function test_RevertWhen_ReceiptResultFailed() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        r.result = false;
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(BountyEscrow.ReceiptFailed.selector);
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_ReceiptFromFuture() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        r.timestamp = uint64(block.timestamp + 1);
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(BountyEscrow.ReceiptFromFuture.selector);
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_ReceiptSignatureMalformed() public {
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        escrow.submitReceipt(r, hex"010203");
    }

    function test_RevertWhen_ReceiptFieldTampered() public {
        // Signature over one runnerVersion, relayed with another: recovers a random signer.
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        bytes memory sig = _sign(runnerKey, r);
        r.runnerVersion = "runner/9.9.9";
        vm.expectRevert(); // UnapprovedSigner(<recovered address>)
        escrow.submitReceipt(r, sig);
    }

    function test_RevertWhen_AcceptUnknownSubmission() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.SubmissionNotFound.selector, 5));
        escrow.acceptSubmission(5);
    }

    function test_RevertWhen_AcceptByNonCreator() public {
        (, uint256 submissionId) = _fullyReviewed();
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.NotCreator.selector);
        escrow.acceptSubmission(submissionId);
    }

    function test_RevertWhen_NonAdminGrantsSigner() public {
        bytes32 role = escrow.RUNNER_ROLE();
        bytes32 adminRole = escrow.DEFAULT_ADMIN_ROLE();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, adminRole)
        );
        escrow.grantRole(role, agent);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_RevertWhen_AnyOtherCommit(bytes32 wrongCommit) public {
        vm.assume(wrongCommit != COMMIT);
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        r.commitHash = wrongCommit;
        bytes memory sig = _sign(runnerKey, r);
        vm.expectRevert(BountyEscrow.WrongCommit.selector);
        escrow.submitReceipt(r, sig);
    }

    function testFuzz_ExpiryBoundary(uint64 ttl, uint64 elapsed) public {
        ttl = uint64(bound(ttl, 0, 30 days));
        elapsed = uint64(bound(elapsed, 0, 60 days));
        uint256 bountyId = _createBounty();
        uint256 submissionId = _submit(bountyId);
        BountyEscrow.Receipt memory r = _receipt(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
        r.expiry = r.timestamp + ttl;
        bytes memory sig = _sign(runnerKey, r);
        vm.warp(block.timestamp + elapsed);
        if (elapsed > ttl) vm.expectRevert(BountyEscrow.ReceiptExpired.selector);
        escrow.submitReceipt(r, sig);
    }

    function testFuzz_EscrowConservesFunds(uint256 amount, bool award) public {
        amount = bound(amount, 1, 10_000e6);
        vm.prank(creator);
        uint256 bountyId = escrow.createBounty(SPEC, SUITE, amount, deadline);
        uint256 creatorAfterFunding = usdc.balanceOf(creator);
        assertEq(usdc.balanceOf(address(escrow)), amount);

        if (award) {
            uint256 submissionId = _submit(bountyId);
            _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Build);
            _attest(bountyId, submissionId, BountyEscrow.ReceiptType.Test);
            _attest(bountyId, submissionId, BountyEscrow.ReceiptType.SecurityReview);
            vm.prank(creator);
            escrow.acceptSubmission(submissionId);
            assertEq(usdc.balanceOf(agent), amount);
        } else {
            vm.warp(deadline + 1);
            vm.prank(creator);
            escrow.refund(bountyId);
            assertEq(usdc.balanceOf(creator), creatorAfterFunding + amount);
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
