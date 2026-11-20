import type { CommandResult } from "./process.js";

export interface SandboxLimits {
  /** CPU cores, e.g. 1 or 0.5. */
  cpus: number;
  memoryMb: number;
  pids: number;
  /** Size of the in-container writable workspace (tmpfs). */
  workspaceMb: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { cpus: 1, memoryMb: 1024, pids: 256, workspaceMb: 512 };

export interface SandboxSpec {
  image: string;
  /** Host directory holding a private copy of the snapshot. Mounted read-only. */
  snapshotDir: string;
  limits: SandboxLimits;
  /** Upper bound on the whole container's lifetime. */
  lifetimeMs: number;
}

export type ExecResult = CommandResult;

export interface SandboxSession {
  /** Runs `command` with `sh -c` inside the sandbox workspace. */
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  destroy(): Promise<void>;
}

/** Container backend. The real one is Docker; tests use a fake. */
export interface SandboxExecutor {
  start(spec: SandboxSpec): Promise<SandboxSession>;
}
