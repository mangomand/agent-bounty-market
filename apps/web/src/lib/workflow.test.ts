import { describe, expect, it } from "vitest";
import { canAccept, checkStatus } from "./workflow";

describe("checkStatus", () => {
  it("marks steps up to the current state verified and the next one running", () => {
    const sub = { state: "BUILD_VERIFIED" as const };
    expect(checkStatus(sub, "BUILD_VERIFIED")).toBe("verified");
    expect(checkStatus(sub, "TESTS_VERIFIED")).toBe("running");
    expect(checkStatus(sub, "SECURITY_REVIEWED")).toBe("pending");
  });

  it("does not show a running step on a closed bounty", () => {
    expect(checkStatus({ state: "CODE_SUBMITTED" }, "BUILD_VERIFIED", true)).toBe("pending");
  });

  it("marks the failed step and skips the rest", () => {
    const sub = { state: "BUILD_VERIFIED" as const, failure: { state: "TESTS_VERIFIED" as const, reason: "x" } };
    expect(checkStatus(sub, "BUILD_VERIFIED")).toBe("verified");
    expect(checkStatus(sub, "TESTS_VERIFIED")).toBe("failed");
    expect(checkStatus(sub, "SECURITY_REVIEWED")).toBe("skipped");
  });
});

describe("canAccept", () => {
  it("requires security review and no failure", () => {
    expect(canAccept({ state: "SECURITY_REVIEWED" })).toBe(true);
    expect(canAccept({ state: "TESTS_VERIFIED" })).toBe(false);
    expect(canAccept({ state: "PAYOUT" })).toBe(false);
    expect(
      canAccept({ state: "SECURITY_REVIEWED", failure: { state: "CREATOR_ACCEPTED", reason: "x" } }),
    ).toBe(false);
  });
});
