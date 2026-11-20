import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PackedSource {
  commitHash: string;
  sourceTarballBase64: string;
}

/**
 * Writes `files` into a fresh git repo, commits them, and returns the commit hash plus
 * a base64 .tar.gz of the tree (without .git). Everything happens in a temp dir that is removed.
 */
export async function packSource(files: Record<string, string>, message = "bounty submission"): Promise<PackedSource> {
  const root = await mkdtemp(join(tmpdir(), "abm-client-"));
  const repo = join(root, "repo");
  try {
    for (const [path, content] of Object.entries(files)) {
      if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`unsafe path: ${path}`);
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    const env = {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: "abm-demo",
      GIT_AUTHOR_EMAIL: "demo@abm.local",
      GIT_COMMITTER_NAME: "abm-demo",
      GIT_COMMITTER_EMAIL: "demo@abm.local",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: root,
    };
    await run("git", ["init", "-q", repo], { env });
    await run("git", ["-C", repo, "add", "-A"], { env });
    await run("git", ["-C", repo, "commit", "-q", "--no-gpg-sign", "-m", message], { env });
    const { stdout } = await run("git", ["-C", repo, "rev-parse", "HEAD"], { env });
    const archive = join(root, "source.tar.gz");
    await run("tar", ["-czf", archive, "--exclude", ".git", "-C", repo, "."], { env: { ...env, COPYFILE_DISABLE: "1" } });
    return { commitHash: stdout.trim(), sourceTarballBase64: (await readFile(archive)).toString("base64") };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
