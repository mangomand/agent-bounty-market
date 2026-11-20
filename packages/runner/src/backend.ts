import { DockerExecutor } from "./docker.js";
import { minimalEnv, runCommand, type CommandRunner } from "./process.js";
import { PROCESS_BACKEND_WARNING, ProcessExecutor } from "./process-executor.js";
import type { SandboxExecutor } from "./sandbox.js";

export type RunnerBackend = "docker" | "process";

/** True when the Docker daemon answers `docker info`. */
export async function dockerAvailable(run: CommandRunner = runCommand): Promise<boolean> {
  try {
    const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000, env: minimalEnv() });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Picks the sandbox backend from RUNNER_BACKEND:
 * - unset / "docker": Docker (the default). Fails if `docker info` doesn't work.
 * - "process": unsandboxed host processes, for local demos only. Prints a loud warning.
 */
export async function selectBackend(
  env: NodeJS.ProcessEnv = process.env,
  opts: { log?: (msg: string) => void; run?: CommandRunner } = {},
): Promise<{ backend: RunnerBackend; executor: SandboxExecutor }> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const wanted = (env.RUNNER_BACKEND ?? "docker").trim().toLowerCase();
  if (wanted === "process") {
    log(PROCESS_BACKEND_WARNING);
    return { backend: "process", executor: new ProcessExecutor() };
  }
  if (wanted !== "docker") throw new Error(`RUNNER_BACKEND must be "docker" or "process", got "${wanted}"`);
  if (!(await dockerAvailable(opts.run))) {
    throw new Error("Docker is not available (`docker info` failed). Start Docker, or set RUNNER_BACKEND=process for an unsandboxed local demo.");
  }
  return { backend: "docker", executor: new DockerExecutor() };
}
