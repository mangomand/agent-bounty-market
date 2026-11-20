import { describe, expect, it } from "vitest";
import { bountyEscrowAbi } from "./abi/bountyEscrow";
import {
  RECEIPT_TYPE,
  commitHashToBytes32,
  receiptDomain,
  receiptPrimaryType,
  receiptTypeString,
  receiptTypes,
} from "./eip712";

// Same string the contract hashes into BUILD_RECEIPT_TYPEHASH and friends.
const FIELDS =
  "(uint256 bountyId,uint256 submissionId,bytes32 commitHash,uint8 receiptType,string runnerVersion,bool result,uint64 timestamp,uint64 expiry)";

describe("eip712 receipts", () => {
  it("matches the contract's type strings", () => {
    expect(receiptTypeString("BuildReceipt")).toBe(`BuildReceipt${FIELDS}`);
    expect(receiptTypeString("TestReceipt")).toBe(`TestReceipt${FIELDS}`);
    expect(receiptTypeString("SecurityReviewReceipt")).toBe(`SecurityReviewReceipt${FIELDS}`);
  });

  it("matches the Receipt tuple in the ABI", () => {
    const fn = bountyEscrowAbi.find((x) => x.type === "function" && x.name === "submitReceipt");
    const tuple = fn && "inputs" in fn ? fn.inputs[0] : undefined;
    const abiFields = tuple && "components" in tuple ? tuple.components.map((c) => [c.name, c.type]) : [];
    expect(abiFields).toEqual(receiptTypes.BuildReceipt.map((f) => [f.name, f.type]));
  });

  it("maps receipt type ids to primary types", () => {
    expect(receiptPrimaryType(RECEIPT_TYPE.Build)).toBe("BuildReceipt");
    expect(receiptPrimaryType(RECEIPT_TYPE.Test)).toBe("TestReceipt");
    expect(receiptPrimaryType(RECEIPT_TYPE.SecurityReview)).toBe("SecurityReviewReceipt");
  });

  it("builds the domain", () => {
    expect(receiptDomain(31337, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512")).toEqual({
      name: "AgentBountyMarket",
      version: "1",
      chainId: 31337n,
      verifyingContract: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    });
  });

  it("pads git commit ids to bytes32", () => {
    const sha1 = "8693975aabbccddeeff00112233445566778899a";
    expect(commitHashToBytes32(sha1)).toBe(`0x${"0".repeat(24)}${sha1}`);
    expect(commitHashToBytes32(`0x${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
    expect(() => commitHashToBytes32("main")).toThrow();
  });
});
