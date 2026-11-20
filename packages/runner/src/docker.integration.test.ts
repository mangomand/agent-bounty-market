import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE, DockerExecutor } from "./docker.js";
import { runSubmission } from "./runner.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    execFileSync("docker", ["image", "inspect", DEFAULT_IMAGE], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// Needs a running Docker daemon and the default image pulled locally.
describe.skipIf(!dockerAvailable())("docker integration", () => {
  it("builds and tests a snapshot with no network", async () => {
    const repo = await mkdtemp(join(tmpdir(), "abm-int-repo-"));
    try {
      await writeFile(join(repo, "test.js"), "require('node:assert').equal(1 + 1, 2); console.log('ok');\n");
      const res = await runSubmission(
        {
          bountyId: "1",
          submissionId: "int-1",
          snapshotPath: repo,
          commitHash: "0123456789abcdef0123456789abcdef01234567",
          buildCommand: "touch built && id -u",
          // The fetch must fail: the sandbox has no network.
          testCommand: "test -f built && node test.js && node -e \"fetch('http://example.com').then(() => process.exit(1), () => process.exit(0))\"",
          runnerVersion: "runner-0.1.0",
        },
        {
          signing: { chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
          signer: privateKeyToAccount(generatePrivateKey()),
          executor: new DockerExecutor(),
          buildTimeoutMs: 60_000,
          testTimeoutMs: 60_000,
        },
      );
      expect(res.build.status).toBe("passed");
      expect(res.build.stdout.trim()).toBe("65534");
      expect(res.test.status).toBe("passed");
      expect(res.receipts.every((r) => r.receipt.result)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 180_000);
});
