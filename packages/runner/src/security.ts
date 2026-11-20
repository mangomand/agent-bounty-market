import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ApiBounty, ApiSubmission } from "@abm/shared";

export interface SecurityReviewInput {
  /** Host dir with the submitted source. Read it; never execute it. */
  dir: string;
  bounty: ApiBounty;
  submission: ApiSubmission;
}

export interface SecurityReviewResult {
  passed: boolean;
  /** Human-readable findings, returned to the agent and the creator. */
  report: string;
  /** Short id recorded in the receipt's runnerVersion, [A-Za-z0-9._-]. */
  reviewer: string;
}

/**
 * Integration point for the security reviewer (packages/agents builds the real one).
 * Load a custom one with SECURITY_REVIEWER_MODULE=<path>, whose default export implements this.
 */
export interface SecurityReviewer {
  review(input: SecurityReviewInput): Promise<SecurityReviewResult>;
}

const RULES: { id: string; re: RegExp; why: string }[] = [
  { id: "child-process", re: /\bchild_process\b/, why: "spawns processes" },
  { id: "eval", re: /\beval\s*\(|\bnew\s+Function\s*\(/, why: "evaluates dynamic code" },
  { id: "env-access", re: /\bprocess\.env\b/, why: "reads environment variables" },
  { id: "network", re: /\bfetch\s*\(|require\(\s*["'](?:node:)?(?:https?|net|dgram|tls)["']\s*\)|from\s+["'](?:node:)?(?:https?|net|dgram|tls)["']/, why: "opens network connections" },
  { id: "install-script", re: /"(?:pre|post)?install"\s*:/, why: "runs an npm install hook" },
];
const SCANNED = /\.(?:[cm]?[jt]sx?|json)$/;
const MAX_FILES = 2_000;
const MAX_BYTES = 512 * 1024;

async function* files(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

/** Baseline static scan: flags process, eval, env, network, and install-hook use in source files. */
export const defaultSecurityReviewer: SecurityReviewer = {
  async review({ dir }) {
    const findings: string[] = [];
    let n = 0;
    for await (const file of files(dir)) {
      if (!SCANNED.test(file)) continue;
      if (++n > MAX_FILES) {
        findings.push(`too many files (> ${MAX_FILES})`);
        break;
      }
      if ((await stat(file)).size > MAX_BYTES) {
        findings.push(`${relative(dir, file)}: file larger than ${MAX_BYTES} bytes`);
        continue;
      }
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        for (const r of RULES) if (r.re.test(line)) findings.push(`${relative(dir, file)}:${i + 1} [${r.id}] ${r.why}: ${line.trim().slice(0, 120)}`);
      });
    }
    const passed = findings.length === 0;
    return {
      passed,
      reviewer: "static-scan",
      report: passed ? `static-scan: ${n} files scanned, no findings` : `static-scan: ${findings.length} finding(s)\n${findings.join("\n")}`,
    };
  },
};

/** Loads SECURITY_REVIEWER_MODULE if set, otherwise the baseline static scan. */
export async function loadSecurityReviewer(env: NodeJS.ProcessEnv = process.env): Promise<SecurityReviewer> {
  const mod = env.SECURITY_REVIEWER_MODULE?.trim();
  if (!mod) return defaultSecurityReviewer;
  const loaded = (await import(mod)) as { default?: SecurityReviewer };
  if (typeof loaded.default?.review !== "function") throw new Error(`${mod} must default-export a SecurityReviewer`);
  return loaded.default;
}
