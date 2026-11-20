/**
 * Cheap, regex-based checks for patterns a bounty submission should not contain.
 * They are a tripwire, not a proof: the LLM review and the sandbox are the other layers.
 */

export type Severity = "high" | "medium" | "low";

export interface SourceFile {
  path: string;
  content: string;
}

export interface Finding {
  source: "static" | "llm";
  rule: string;
  severity: Severity;
  file: string;
  /** 1-based; 0 when the finding is not tied to a line. */
  line: number;
  message: string;
  snippet?: string;
}

interface Rule {
  id: string;
  severity: Severity;
  message: string;
  pattern: RegExp;
  /** Test files legitimately use some APIs (fs fixtures); lower the severity there. */
  testSeverity?: Severity;
}

export const STATIC_RULES: readonly Rule[] = [
  {
    id: "network",
    severity: "high",
    message: "network access",
    pattern:
      /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bnew\s+EventSource\b|\b(?:require\s*\(\s*|from\s+|import\s*\(\s*)["'](?:node:)?(?:https?|http2|net|tls|dgram|dns)["']|\baxios\b|\bundici\b/,
  },
  {
    id: "env",
    severity: "high",
    message: "reads environment variables or secrets",
    pattern: /\bprocess\.env\b|\bDeno\.env\b|\bBun\.env\b|\bimport\.meta\.env\b|\.env(?:\.local)?["']|PRIVATE_KEY|API_KEY/,
  },
  {
    id: "dynamic-code",
    severity: "high",
    message: "dynamic code execution",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn|Script|compileFunction)|(?:require\s*\(\s*|from\s+|import\s*\(\s*)["'](?:node:)?vm["']/,
  },
  {
    id: "child-process",
    severity: "high",
    message: "spawns processes",
    pattern:
      /(?:require\s*\(\s*|from\s+|import\s*\(\s*)["'](?:node:)?child_process["']|\b(?:execSync|execFileSync|spawnSync)\s*\(|\bprocess\.binding\s*\(|\bworker_threads\b/,
  },
  {
    id: "fs-escape",
    severity: "high",
    testSeverity: "low",
    message: "touches paths outside the workspace",
    pattern:
      /["'`](?:\/(?:etc|root|home|Users|var|proc|sys|dev|tmp)\b|~\/|(?:\.\.\/){2,})|\bos\.homedir\s*\(|\bprocess\.chdir\s*\(|\bhomedir\s*\(\)/,
  },
  {
    id: "install-script",
    severity: "high",
    message: "npm install hook runs code on install",
    pattern: /"(?:pre|post)?install"\s*:/,
  },
  {
    id: "symlink",
    severity: "medium",
    message: "symlink in submission (not followed)",
    pattern: /^\/\/ symlink \(not followed\)$/,
  },
  {
    id: "process-control",
    severity: "medium",
    message: "kills or exits the process",
    pattern: /\bprocess\.(?:kill|abort)\s*\(|\bprocess\.exit\s*\(/,
  },
];

const CODE_EXT = /\.(?:[cm]?[jt]sx?|json|sh|py)$/;
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Runs every static rule over every code file. Comments are scanned too: hiding a call in one is no defence. */
export function staticChecks(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const symlink = f.content === "// symlink (not followed)";
    if ((!symlink && !CODE_EXT.test(f.path)) ||f.path.includes("node_modules/") || f.path.endsWith("package-lock.json")) continue;
    const inTest = isTestFile(f.path);
    f.content.split("\n").forEach((text, i) => {
      for (const rule of STATIC_RULES) {
        if (!rule.pattern.test(text)) continue;
        findings.push({
          source: "static",
          rule: rule.id,
          severity: inTest && rule.testSeverity ? rule.testSeverity : rule.severity,
          file: f.path,
          line: i + 1,
          message: rule.message,
          snippet: text.trim().slice(0, 160),
        });
      }
    });
  }
  return findings;
}
