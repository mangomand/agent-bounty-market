// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title BountyEscrow
/// @notice Escrows ERC-20 bounties and releases them only after a submission has passed
///         build, test, and security review (each proven by an EIP-712 receipt from an
///         allowlisted signer) and the bounty creator has accepted it.
/// @dev The contract is the only payout authority. Code and logs stay off-chain; only hashes
///      and settlement state are stored.
contract BountyEscrow is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------

    /// @dev Order matches WORKFLOW_STATES in packages/shared. Submissions start at CodeSubmitted.
    enum WorkflowState {
        BountyCreated,
        CodeSubmitted,
        BuildVerified,
        TestsVerified,
        SecurityReviewed,
        CreatorAccepted,
        Payout
    }

    enum BountyStatus {
        None,
        Open,
        Awarded,
        Refunded
    }

    enum ReceiptType {
        Build,
        Test,
        SecurityReview
    }

    struct Bounty {
        address creator;
        uint64 deadline;
        BountyStatus status;
        uint256 amount;
        bytes32 specHash;
        bytes32 testSuiteHash;
        uint256 awardedSubmissionId;
    }

    struct Submission {
        uint256 bountyId;
        address submitter;
        WorkflowState state;
        bytes32 commitHash;
        bytes32 buildReceipt;
        bytes32 testReceipt;
        bytes32 securityReceipt;
    }

    /// @dev Field order is part of the EIP-712 type string; keep in sync with
    ///      packages/shared/src/eip712.ts.
    struct Receipt {
        uint256 bountyId;
        uint256 submissionId;
        bytes32 commitHash;
        uint8 receiptType;
        string runnerVersion;
        bool result;
        uint64 timestamp;
        uint64 expiry;
    }

    // ---------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------

    /// @notice Signers allowed to attest build and test receipts.
    bytes32 public constant RUNNER_ROLE = keccak256("RUNNER_ROLE");
    /// @notice Signers allowed to attest security review receipts.
    bytes32 public constant REVIEWER_ROLE = keccak256("REVIEWER_ROLE");

    string private constant RECEIPT_FIELDS =
        "(uint256 bountyId,uint256 submissionId,bytes32 commitHash,uint8 receiptType,string runnerVersion,bool result,uint64 timestamp,uint64 expiry)";

    bytes32 public constant BUILD_RECEIPT_TYPEHASH = keccak256(abi.encodePacked("BuildReceipt", RECEIPT_FIELDS));
    bytes32 public constant TEST_RECEIPT_TYPEHASH = keccak256(abi.encodePacked("TestReceipt", RECEIPT_FIELDS));
    bytes32 public constant SECURITY_REVIEW_RECEIPT_TYPEHASH =
        keccak256(abi.encodePacked("SecurityReviewReceipt", RECEIPT_FIELDS));

    // ---------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------

    IERC20 public immutable token;

    uint256 public bountyCount;
    uint256 public submissionCount;

    mapping(uint256 bountyId => Bounty) private _bounties;
    mapping(uint256 submissionId => Submission) private _submissions;
    mapping(bytes32 digest => bool) public receiptUsed;

    // ---------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amount,
        bytes32 specHash,
        bytes32 testSuiteHash,
        uint64 deadline
    );
    event SubmissionRegistered(
        uint256 indexed bountyId, uint256 indexed submissionId, address indexed submitter, bytes32 commitHash
    );
    event StateChanged(uint256 indexed submissionId, WorkflowState from, WorkflowState to);
    event ReceiptVerified(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        ReceiptType receiptType,
        bytes32 digest,
        address indexed signer
    );
    event PayoutReleased(uint256 indexed bountyId, uint256 indexed submissionId, address indexed to, uint256 amount);
    event BountyRefunded(uint256 indexed bountyId, address indexed creator, uint256 amount);

    // ---------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ZeroHash();
    error DeadlineInPast();
    error BountyNotFound(uint256 bountyId);
    error BountyNotOpen(uint256 bountyId);
    error DeadlinePassed(uint256 bountyId);
    error DeadlineNotReached(uint256 bountyId);
    error SubmissionNotFound(uint256 submissionId);
    error NotCreator();
    error WrongBounty();
    error WrongCommit();
    error InvalidReceiptType(uint8 receiptType);
    error ReceiptFailed();
    error ReceiptFromFuture();
    error ReceiptExpired();
    error ReceiptAlreadyUsed(bytes32 digest);
    error UnapprovedSigner(address signer);
    error InvalidTransition(WorkflowState from, WorkflowState to);

    // ---------------------------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------------------------

    constructor(IERC20 token_, address admin) EIP712("AgentBountyMarket", "1") {
        if (address(token_) == address(0) || admin == address(0)) revert ZeroAddress();
        token = token_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------------
    // Bounties
    // ---------------------------------------------------------------------------------------

    /// @notice Creates a bounty and pulls `amount` tokens into escrow. The caller must have
    ///         approved this contract first. The spec and test suite hashes are locked forever.
    function createBounty(bytes32 specHash, bytes32 testSuiteHash, uint256 amount, uint64 deadline)
        external
        nonReentrant
        returns (uint256 bountyId)
    {
        if (amount == 0) revert ZeroAmount();
        if (specHash == bytes32(0) || testSuiteHash == bytes32(0)) revert ZeroHash();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        bountyId = ++bountyCount;
        _bounties[bountyId] = Bounty({
            creator: msg.sender,
            deadline: deadline,
            status: BountyStatus.Open,
            amount: amount,
            specHash: specHash,
            testSuiteHash: testSuiteHash,
            awardedSubmissionId: 0
        });

        emit BountyCreated(bountyId, msg.sender, amount, specHash, testSuiteHash, deadline);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Returns escrowed funds to the creator once the deadline passes without an award.
    function refund(uint256 bountyId) external nonReentrant {
        Bounty storage b = _openBounty(bountyId);
        if (msg.sender != b.creator) revert NotCreator();
        if (block.timestamp <= b.deadline) revert DeadlineNotReached(bountyId);

        b.status = BountyStatus.Refunded;
        uint256 amount = b.amount;
        emit BountyRefunded(bountyId, b.creator, amount);
        token.safeTransfer(b.creator, amount);
    }

    // ---------------------------------------------------------------------------------------
    // Submissions
    // ---------------------------------------------------------------------------------------

    /// @notice Registers a commit against an open bounty. `submitter` receives the payout if
    ///         the submission is accepted. Registration alone grants nothing: every later step
    ///         needs a signed receipt bound to this submission id and commit.
    function submitCode(uint256 bountyId, bytes32 commitHash, address submitter)
        external
        returns (uint256 submissionId)
    {
        Bounty storage b = _openBounty(bountyId);
        if (block.timestamp > b.deadline) revert DeadlinePassed(bountyId);
        if (commitHash == bytes32(0)) revert ZeroHash();
        if (submitter == address(0)) revert ZeroAddress();

        submissionId = ++submissionCount;
        _submissions[submissionId] = Submission({
            bountyId: bountyId,
            submitter: submitter,
            state: WorkflowState.CodeSubmitted,
            commitHash: commitHash,
            buildReceipt: bytes32(0),
            testReceipt: bytes32(0),
            securityReceipt: bytes32(0)
        });

        emit SubmissionRegistered(bountyId, submissionId, submitter, commitHash);
        emit StateChanged(submissionId, WorkflowState.BountyCreated, WorkflowState.CodeSubmitted);
    }

    /// @notice Verifies a signed receipt and advances the submission one workflow step.
    ///         Anyone may relay a receipt; the signature is the authority.
    function submitReceipt(Receipt calldata r, bytes calldata signature) external {
        Submission storage s = _submissions[r.submissionId];
        if (s.state == WorkflowState.BountyCreated) revert SubmissionNotFound(r.submissionId);
        if (s.bountyId != r.bountyId) revert WrongBounty();
        _openBounty(r.bountyId);

        bytes32 digest = hashReceipt(r);
        address signer = ECDSA.recover(digest, signature);
        ReceiptType rType = ReceiptType(r.receiptType); // in range: hashReceipt reverts otherwise
        bytes32 role = rType == ReceiptType.SecurityReview ? REVIEWER_ROLE : RUNNER_ROLE;
        if (!hasRole(role, signer)) revert UnapprovedSigner(signer);

        if (receiptUsed[digest]) revert ReceiptAlreadyUsed(digest);
        if (r.commitHash != s.commitHash) revert WrongCommit();
        if (!r.result) revert ReceiptFailed();
        if (r.timestamp > block.timestamp) revert ReceiptFromFuture();
        if (block.timestamp > r.expiry) revert ReceiptExpired();

        WorkflowState from = s.state;
        WorkflowState to;
        if (rType == ReceiptType.Build) {
            to = WorkflowState.BuildVerified;
            s.buildReceipt = digest;
        } else if (rType == ReceiptType.Test) {
            to = WorkflowState.TestsVerified;
            s.testReceipt = digest;
        } else {
            to = WorkflowState.SecurityReviewed;
            s.securityReceipt = digest;
        }
        _requireNext(from, to);

        receiptUsed[digest] = true;
        s.state = to;
        emit ReceiptVerified(r.bountyId, r.submissionId, rType, digest, signer);
        emit StateChanged(r.submissionId, from, to);
    }

    /// @notice Creator accepts a fully reviewed submission. Pays the submitter in the same tx.
    function acceptSubmission(uint256 submissionId) external nonReentrant {
        Submission storage s = _submissions[submissionId];
        if (s.state == WorkflowState.BountyCreated) revert SubmissionNotFound(submissionId);
        Bounty storage b = _openBounty(s.bountyId);
        if (msg.sender != b.creator) revert NotCreator();

        _advance(submissionId, s, WorkflowState.CreatorAccepted);

        // Payout: CREATOR_ACCEPTED -> PAYOUT. Effects before the transfer.
        _advance(submissionId, s, WorkflowState.Payout);
        b.status = BountyStatus.Awarded;
        b.awardedSubmissionId = submissionId;
        uint256 amount = b.amount;
        emit PayoutReleased(s.bountyId, submissionId, s.submitter, amount);
        token.safeTransfer(s.submitter, amount);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return _bounties[bountyId];
    }

    function getSubmission(uint256 submissionId) external view returns (Submission memory) {
        return _submissions[submissionId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 digest a signer signs for `r`.
    function hashReceipt(Receipt calldata r) public view returns (bytes32) {
        bytes32 typehash;
        if (r.receiptType == uint8(ReceiptType.Build)) typehash = BUILD_RECEIPT_TYPEHASH;
        else if (r.receiptType == uint8(ReceiptType.Test)) typehash = TEST_RECEIPT_TYPEHASH;
        else if (r.receiptType == uint8(ReceiptType.SecurityReview)) typehash = SECURITY_REVIEW_RECEIPT_TYPEHASH;
        else revert InvalidReceiptType(r.receiptType);

        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    typehash,
                    r.bountyId,
                    r.submissionId,
                    r.commitHash,
                    r.receiptType,
                    keccak256(bytes(r.runnerVersion)),
                    r.result,
                    r.timestamp,
                    r.expiry
                )
            )
        );
    }

    // ---------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------

    function _openBounty(uint256 bountyId) private view returns (Bounty storage b) {
        b = _bounties[bountyId];
        if (b.status == BountyStatus.None) revert BountyNotFound(bountyId);
        if (b.status != BountyStatus.Open) revert BountyNotOpen(bountyId);
    }

    function _advance(uint256 submissionId, Submission storage s, WorkflowState to) private {
        WorkflowState from = s.state;
        _requireNext(from, to);
        s.state = to;
        emit StateChanged(submissionId, from, to);
    }

    function _requireNext(WorkflowState from, WorkflowState to) private pure {
        if (uint8(to) != uint8(from) + 1) revert InvalidTransition(from, to);
    }
}
