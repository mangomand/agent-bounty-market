import { describe, expect, it } from "vitest";
import { isValidTransition, nextState } from "./index";

describe("workflow", () => {
  it("allows only the next state", () => {
    expect(isValidTransition("CODE_SUBMITTED", "BUILD_VERIFIED")).toBe(true);
    expect(isValidTransition("CODE_SUBMITTED", "TESTS_VERIFIED")).toBe(false);
    expect(isValidTransition("BUILD_VERIFIED", "CODE_SUBMITTED")).toBe(false);
  });

  it("ends at PAYOUT", () => {
    expect(nextState("PAYOUT")).toBeNull();
  });
});
