import { describe, expect, it } from "vitest";
import { txUrl } from "./config";

describe("txUrl", () => {
  it("returns null without an explorer", () => {
    expect(txUrl("0xabc", undefined)).toBeNull();
  });
  it("joins the explorer base and hash", () => {
    expect(txUrl("0xabc", "https://explorer.test/")).toBe("https://explorer.test/tx/0xabc");
  });
});
