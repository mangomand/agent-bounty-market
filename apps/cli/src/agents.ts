import { createHash } from "node:crypto";
import type { BountyView } from "./api/types";

/**
 * A coding agent the CLI can start against a bounty. The real agents live in
 * packages/agents and submit through the MCP server; until that lands, the
 * CLI ships scripted stand-ins with the same shape.
 */
export interface CodingAgent {
  id: string;
  description: string;
  /** Work on the bounty, reporting progress lines. Resolves with the commit to submit. */
  run(bounty: BountyView, log: (line: string) => void, signal?: AbortSignal): Promise<{ commitHash: string }>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

function scripted(id: string, description: string, steps: string[]): CodingAgent {
  return {
    id,
    description,
    async run(bounty, log, signal) {
      const stepMs = Number(process.env.ABM_AGENT_STEP_MS) || 450;
      for (const step of steps) {
        log(step.replace("{repo}", bounty.repo ?? bounty.id).replace("{test}", bounty.testCommand ?? "tests"));
        await sleep(stepMs, signal);
      }
      const commitHash = createHash("sha1").update(`${id}:${bounty.id}:${Date.now()}`).digest("hex");
      return { commitHash };
    },
  };
}

export const AGENTS: CodingAgent[] = [
  scripted("test-focused", "Writes tests first, then the fix", [
    "Cloning {repo}",
    "Reading bounty spec",
    "Writing failing tests",
    "Implementing change",
    "Running {test} locally",
    "Committing",
  ]),
  scripted("security-focused", "Audits inputs and shell calls before submitting", [
    "Cloning {repo}",
    "Reading bounty spec",
    "Implementing change",
    "Auditing for injection and unsafe input",
    "Committing",
  ]),
  scripted("fast-careless", "Ships the first thing that compiles", [
    "Cloning {repo}",
    "Implementing change",
    "Committing",
  ]),
];

export function findAgent(id: string): CodingAgent | undefined {
  return AGENTS.find((a) => a.id === id);
}
