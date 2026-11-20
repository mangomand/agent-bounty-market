import { describe, expect, it } from "vitest";
import { validateBounty, type BountyForm } from "./validate";

const now = new Date("2026-11-19T12:00").getTime();
const valid: BountyForm = {
  title: " Rate limiter ",
  spec: "Build it",
  testCommand: "pnpm test",
  amountUsdc: "250.5",
  deadline: "2026-11-26T12:00",
};

describe("validateBounty", () => {
  it("returns trimmed input with a unix deadline", () => {
    const r = validateBounty(valid, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.title).toBe("Rate limiter");
      expect(r.input.amountUsdc).toBe("250.5");
      expect(r.input.deadline).toBe(Math.floor(new Date("2026-11-26T12:00").getTime() / 1000));
    }
  });

  it.each(["0", "-1", "abc", "1.1234567", ""])("rejects amount %j", (amountUsdc) => {
    const r = validateBounty({ ...valid, amountUsdc }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amountUsdc).toBeDefined();
  });

  it("rejects a past deadline and empty fields", () => {
    const r = validateBounty({ ...valid, title: " ", spec: "", deadline: "2026-11-18T12:00" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["deadline", "spec", "title"]);
  });
});
