import { spawn } from "node:child_process";

export interface CommandResult {
  /** Process exit code, or null when it was killed (e.g. on timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when either stream exceeded `maxOutputBytes` and was cut. */
  truncated: boolean;
  durationMs: number;
}

export interface CommandOptions {
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (cmd: string, args: readonly string[], opts: CommandOptions) => Promise<CommandResult>;

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Minimal env for host-side helper processes (the docker CLI). Deliberately
 * excludes everything else so the signing key never reaches a child process.
 */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

class Capped {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Spawns a process without a shell, caps captured output, and SIGKILLs it on timeout. */
export const runCommand: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const out = new Capped(max);
    const err = new Capped(max);
    let timedOut = false;

    const child = spawn(cmd, [...args], {
      env: opts.env ?? minimalEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - started,
      });
    });
  });
