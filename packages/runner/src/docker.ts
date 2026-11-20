import { randomBytes } from "node:crypto";
import { minimalEnv, runCommand, type CommandRunner } from "./process.js";
import type { ExecResult, SandboxExecutor, SandboxSession, SandboxSpec } from "./sandbox.js";

/** nobody:nogroup on Debian/Alpine images. Never root. */
export const SANDBOX_USER = "65534:65534";
export const SNAPSHOT_MOUNT = "/snapshot";
export const WORKDIR = "/work";

export const DEFAULT_IMAGE = "node:22-bookworm-slim";

/** Arguments for `docker run` that start an idle, locked-down container. */
export function buildRunArgs(spec: SandboxSpec, name: string): string[] {
  if (spec.snapshotDir.includes(",")) throw new Error("snapshot path must not contain ','");
  const { cpus, memoryMb, pids, workspaceMb } = spec.limits;
  const lifetimeSec = Math.max(1, Math.ceil(spec.lifetimeMs / 1000));
  return [
    "run",
    "--detach",
    "--rm",
    "--name", name,
    "--network", "none",
    "--user", SANDBOX_USER,
    "--cpus", String(cpus),
    "--memory", `${memoryMb}m`,
    "--memory-swap", `${memoryMb}m`,
    "--pids-limit", String(pids),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", `${WORKDIR}:rw,exec,nosuid,size=${workspaceMb}m,uid=65534,gid=65534,mode=0700`,
    "--tmpfs", "/tmp:rw,nosuid,size=64m,mode=1777",
    "--mount", `type=bind,source=${spec.snapshotDir},target=${SNAPSHOT_MOUNT},readonly`,
    "--workdir", WORKDIR,
    "--entrypoint", "sleep",
    spec.image,
    String(lifetimeSec),
  ];
}

/** Arguments for `docker exec` running one step. No `-e`: host env never crosses in. */
export function buildExecArgs(name: string, command: string): string[] {
  return ["exec", "--workdir", WORKDIR, name, "sh", "-c", `export HOME=/tmp; ${command}`];
}

export function buildRemoveArgs(name: string): string[] {
  return ["rm", "--force", name];
}

export interface DockerExecutorOptions {
  docker?: string;
  run?: CommandRunner;
  /** Env for the docker CLI process. Defaults to a minimal allowlist. */
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export class DockerExecutor implements SandboxExecutor {
  private readonly docker: string;
  private readonly run: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxOutputBytes: number | undefined;

  constructor(opts: DockerExecutorOptions = {}) {
    this.docker = opts.docker ?? "docker";
    this.run = opts.run ?? runCommand;
    this.env = opts.env ?? minimalEnv();
    this.maxOutputBytes = opts.maxOutputBytes;
  }

  async start(spec: SandboxSpec): Promise<SandboxSession> {
    const name = `abm-run-${randomBytes(6).toString("hex")}`;
    const started = await this.run(this.docker, buildRunArgs(spec, name), { timeoutMs: 60_000, env: this.env });
    if (started.exitCode !== 0) {
      throw new Error(`docker run failed (${started.exitCode ?? "timeout"}): ${started.stderr.trim()}`);
    }
    const session = new DockerSession(this.docker, name, this.run, this.env, this.maxOutputBytes);
    const copied = await session.exec(`cp -R ${SNAPSHOT_MOUNT}/. ${WORKDIR}/`, 60_000);
    if (copied.exitCode !== 0) {
      await session.destroy();
      throw new Error(`copying snapshot into sandbox failed: ${copied.stderr.trim()}`);
    }
    return session;
  }
}

class DockerSession implements SandboxSession {
  private destroyed = false;

  constructor(
    private readonly docker: string,
    readonly name: string,
    private readonly run: CommandRunner,
    private readonly env: NodeJS.ProcessEnv,
    private readonly maxOutputBytes: number | undefined,
  ) {}

  async exec(command: string, timeoutMs: number): Promise<ExecResult> {
    if (this.destroyed) throw new Error("sandbox already destroyed");
    const res = await this.run(this.docker, buildExecArgs(this.name, command), {
      timeoutMs,
      env: this.env,
      maxOutputBytes: this.maxOutputBytes,
    });
    // Killing the docker CLI leaves the process running in the container,
    // so a timeout tears the whole container down.
    if (res.timedOut) await this.destroy();
    return res;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.run(this.docker, buildRemoveArgs(this.name), { timeoutMs: 30_000, env: this.env }).catch(() => undefined);
  }
}
