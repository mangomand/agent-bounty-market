import type { Receipt } from "@abm/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { loadSignerFromEnv, recoverReceiptSigner, signReceipt, SIGNER_ENV_VAR } from "./signer.js";

const ctx = { chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" } as const;
const receipt: Receipt = {
  bountyId: "1",
  submissionId: "sub-1",
  commitHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  receiptType: "TestReceipt",
  runnerVersion: "runner-0.1.0",
  result: true,
  timestamp: 1_800_000_000,
  expiry: 1_800_086_400,
};

describe("receipt signing", () => {
  it("roundtrips sign and recover", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signReceipt(account, receipt, ctx);
    expect(signed.signer).toBe(account.address);
    expect(await recoverReceiptSigner(signed, ctx)).toBe(account.address);
  });

  it("recovers a different address when any field changes", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = await signReceipt(account, receipt, ctx);
    const tampered = { ...signed, receipt: { ...receipt, commitHash: "deadbeefdeadbeef" } };
    expect(await recoverReceiptSigner(tampered, ctx)).not.toBe(account.address);
    expect(await recoverReceiptSigner(signed, { ...ctx, chainId: 1 })).not.toBe(account.address);
  });

  it("refuses to sign creator acceptance", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(signReceipt(account, { ...receipt, receiptType: "CreatorAcceptance" }, ctx)).rejects.toThrow();
  });

  it("loads the key from env and validates it", () => {
    const key = generatePrivateKey();
    expect(loadSignerFromEnv({ [SIGNER_ENV_VAR]: key }).address).toBe(privateKeyToAccount(key).address);
    expect(() => loadSignerFromEnv({})).toThrow(/not set/);
    expect(() => loadSignerFromEnv({ [SIGNER_ENV_VAR]: "0x1234" })).toThrow(/32-byte/);
  });
});
