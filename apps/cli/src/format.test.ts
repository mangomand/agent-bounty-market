import { describe, expect, it } from "vitest";
import {
  fit,
  formatRelative,
  formatUsdc,
  shortCommit,
  shortHash,
  statusText,
  stepsFor,
  SUBMISSION_STEPS,
  truncate,
} from "./format";

describe("shortHash", () => {
  it("keeps the prefix, head, and tail", () => {
    expect(shortHash("0x3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6b27e")).toBe("0x3f9a1c…b27e");
    expect(shortHash("0xabcdef0123456789", 4, 2)).toBe("0xabcd…89");
  });
  it("leaves short values alone", () => {
    expect(shortHash("0xabcdef")).toBe("0xabcdef");
  });
});

describe("shortCommit", () => {
  it("returns 7 chars without a 0x prefix", () => {
    expect(shortCommit("9f1c2e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e")).toBe("9f1c2e7");
    expect(shortCommit("0x9f1c2e7a8b")).toBe("9f1c2e7");
  });
});

describe("formatUsdc", () => {
  it("formats 6-decimal base units", () => {
    expect(formatUsdc("250000000")).toBe("250.00 USDC");
    expect(formatUsdc("1234567890000")).toBe("1,234,567.89 USDC");
    expect(formatUsdc("5", false)).toBe("0.00");
  });
  it("passes through junk instead of throwing", () => {
    expect(formatUsdc("abc")).toBe("abc USDC");
  });
});

describe("formatRelative", () => {
  const now = 1_700_000_000_000;
  const s = now / 1000;
  it("describes future and past spans", () => {
    expect(formatRelative(s + 2 * 86_400 + 5 * 3600, now)).toBe("in 2d 5h");
    expect(formatRelative(s + 35 * 60, now)).toBe("in 35m");
    expect(formatRelative(s - 3 * 3600, now)).toBe("3h ago");
    expect(formatRelative(s + 10, now)).toBe("now");
  });
});

describe("truncate / fit", () => {
  it("cuts with an ellipsis", () => {
    expect(truncate("Token-bucket rate limiter", 10)).toBe("Token-buc…");
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abc", 0)).toBe("");
  });
  it("pads to width", () => {
    expect(fit("ab", 4)).toBe("ab  ");
    expect(fit("ab", 4, "right")).toBe("  ab");
    expect(fit("abcdef", 4)).toBe("abc…");
  });
});

describe("stepsFor", () => {
  it("skips BOUNTY_CREATED and ends at PAYOUT", () => {
    expect(SUBMISSION_STEPS[0]).toBe("CODE_SUBMITTED");
    expect(SUBMISSION_STEPS.at(-1)).toBe("PAYOUT");
  });

  it("marks the next step active while running", () => {
    const steps = stepsFor({ state: "BUILD_VERIFIED", status: "running" });
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "active", "todo", "todo", "todo"]);
  });

  it("marks the failed step and skips the rest when rejected", () => {
    const steps = stepsFor({ state: "BUILD_VERIFIED", status: "rejected" });
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "failed", "skipped", "skipped", "skipped"]);
  });

  it("waits on the creator after security review", () => {
    const steps = stepsFor({ state: "SECURITY_REVIEWED", status: "waiting" });
    expect(steps[4]).toMatchObject({ label: "Accepted", status: "waiting" });
  });

  it("is all done when paid", () => {
    expect(stepsFor({ state: "PAYOUT", status: "paid" }).every((s) => s.status === "done")).toBe(true);
  });
});

describe("statusText", () => {
  it("names the activity or the failure", () => {
    expect(statusText({ state: "BUILD_VERIFIED", status: "running" })).toBe("running tests");
    expect(statusText({ state: "BUILD_VERIFIED", status: "rejected", reason: "2 failed" })).toBe(
      "rejected at tests: 2 failed",
    );
    expect(statusText({ state: "SECURITY_REVIEWED", status: "waiting" })).toBe("awaiting creator");
  });
});
