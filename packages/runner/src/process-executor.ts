import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandRunner } from "./process.js";
import type { ExecResult, SandboxExecutor, SandboxSession, SandboxSpec } from "./sandbox.js";

export const PROCESS_BACKEND_WARNING = [
  "",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "!! RUNNER_BACKEND=process: submissions run as plain host processes.    !!",
  "!! NOT SANDBOXED: no network, filesystem, or CPU/memory isolation.     !!",
  "!! Local demos with trusted code only. Install Docker for real runs.   !!",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "",
].join("\n");

/**
 * LOCAL DEMO ONLY. Runs each step with `sh -c` in a temp copy of the snapshot on the host.
 * It enforces the time limit and strips the env (so the signing key never reaches the
 * child), but it is NOT a sandbox: no network, filesystem, CPU, or memory isolation.
 */
export class ProcessExecutor implements SandboxExecutor {
  constructor(private readonly run: CommandRunner = runCommand) {}

  async start(spec: SandboxSpec): Promise<SandboxSession> {
    const root = await mkdtemp(join(tmpdir(), "abm-process-"));
    const work = join(root, "work");
    const home = join(root, "home");
    await cp(spec.snapshotDir, work, { recursive: true, verbatimSymlinks: true });
    await mkdir(home);
    return new ProcessSession(root, work, home, this.run);
  }
}

class ProcessSession implements SandboxSession {
  private destroyed = false;
  constructor(
    private readonly root: string,
    private readonly work: string,
    private readonly home: string,
    private readonly run: CommandRunner,
  ) {}

  async exec(command: string, timeoutMs: number): Promise<ExecResult> {
    if (this.destroyed) throw new Error("session already destroyed");
    // Only PATH and a throwaway HOME: no secrets or other host env cross over.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.home, CI: "1", NO_COLOR: "1" };
    return this.run("sh", ["-c", `cd "$0" && ${command}`, this.work], { timeoutMs, env });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await rm(this.root, { recursive: true, force: true });
  }
}
