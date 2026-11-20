import { describe, expect, it } from "vitest";
import { buildExecArgs, buildRunArgs, DockerExecutor, SANDBOX_USER } from "./docker.js";
import type { CommandOptions, CommandResult } from "./process.js";
import { minimalEnv } from "./process.js";
import { DEFAULT_LIMITS, type SandboxSpec } from "./sandbox.js";

const spec: SandboxSpec = {
  image: "node:22-bookworm-slim",
  snapshotDir: "/tmp/abm-snapshot-abc",
  limits: { cpus: 1.5, memoryMb: 768, pids: 128, workspaceMb: 256 },
  lifetimeMs: 90_500,
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const ENV_FLAGS = ["-e", "--env", "--env-file"];

describe("docker arguments", () => {
  const args = buildRunArgs(spec, "abm-run-test");

  it("disables networking", () => {
    expect(flag(args, "--network")).toBe("none");
  });

  it("applies resource limits", () => {
    expect(flag(args, "--cpus")).toBe("1.5");
    expect(flag(args, "--memory")).toBe("768m");
    expect(flag(args, "--memory-swap")).toBe("768m");
    expect(flag(args, "--pids-limit")).toBe("128");
    expect(args.at(-1)).toBe("91");
  });

  it("runs as non-root with no capabilities", () => {
    expect(flag(args, "--user")).toBe(SANDBOX_USER);
    expect(SANDBOX_USER.startsWith("0")).toBe(false);
    expect(flag(args, "--cap-drop")).toBe("ALL");
    expect(flag(args, "--security-opt")).toBe("no-new-privileges");
    expect(args).toContain("--read-only");
  });

  it("mounts the snapshot read-only and nothing else from the host", () => {
    const mounts = args.filter((_, i) => args[i - 1] === "--mount");
    expect(mounts).toEqual([`type=bind,source=${spec.snapshotDir},target=/snapshot,readonly`]);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
  });

  it("passes no env into the container", () => {
    for (const a of [...args, ...buildExecArgs("abm-run-test", "npm test")]) {
      expect(ENV_FLAGS).not.toContain(a);
    }
  });

  it("rejects snapshot paths that could inject mount options", () => {
    expect(() => buildRunArgs({ ...spec, snapshotDir: "/tmp/x,target=/etc" }, "n")).toThrow();
  });

  it("runs commands through sh -c inside the workspace", () => {
    expect(buildExecArgs("c", "npm test")).toEqual(["exec", "--workdir", "/work", "c", "sh", "-c", "export HOME=/tmp; npm test"]);
  });

  it("keeps the signing key out of the docker CLI env", () => {
    const env = minimalEnv({ PATH: "/usr/bin", RUNNER_SIGNER_PRIVATE_KEY: "0xsecret", OPENAI_API_KEY: "x" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("DockerExecutor", () => {
  type Call = { cmd: string; args: readonly string[]; opts: CommandOptions };
  const ok = (over: Partial<CommandResult> = {}): CommandResult => ({
    exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1, ...over,
  });

  it("tears down the container when a step times out", async () => {
    const calls: Call[] = [];
    const exec = new DockerExecutor({
      env: { PATH: "/usr/bin" },
      run: async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (args[0] === "exec" && args.at(-1)?.includes("sleep")) return ok({ exitCode: null, timedOut: true });
        return ok();
      },
    });
    const session = await exec.start({ ...spec, limits: DEFAULT_LIMITS });
    const res = await session.exec("sleep 999", 50);
    expect(res.timedOut).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(["run", "exec", "exec", "rm"]);
    expect(calls.every((c) => c.opts.env?.RUNNER_SIGNER_PRIVATE_KEY === undefined)).toBe(true);
    await expect(session.exec("echo", 1000)).rejects.toThrow(/destroyed/);
  });

  it("fails start when docker run fails", async () => {
    const exec = new DockerExecutor({ run: async () => ok({ exitCode: 125, stderr: "no such image" }) });
    await expect(exec.start(spec)).rejects.toThrow(/no such image/);
  });
});
