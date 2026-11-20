import { parseArgs } from "node:util";
import { connectHttp, DEFAULT_MCP_URL } from "./clients/mcp";
import { matches, runAdversarial, runBroken, type ScriptReport } from "./clients/scripted";
import { AnthropicLlm } from "./llm";
import { readSourceTree, reviewSource } from "./review/reviewer";

/** Anvil's well-known account #9: a demo-only payout address, never a real wallet. */
const DEMO_PAYOUT = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";

const USAGE = `Usage:
  abm-agents adversarial --bounty <id> [--mcp-url <url>] [--payout <0x…>] [--wait <sec>]
  abm-agents broken      --bounty <id> [--mcp-url <url>] [--payout <0x…>] [--wait <sec>]
  abm-agents review      --dir <path> [--no-llm] [--model <id>]

MCP URL defaults to $ABM_MCP_URL or ${DEFAULT_MCP_URL}.
--payout defaults to Anvil account #9 (${DEMO_PAYOUT}).`;

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const yellow = (s: string) => paint(33, s);

function printReport(r: ScriptReport): void {
  console.log(`\n${r.client} client on ${r.bountyId}`);
  for (const s of r.steps) {
    const status = s.outcome === "rejected" ? red("rejected") : green("accepted");
    const mark = matches(s) ? "  " : yellow("! ");
    console.log(`${mark}${s.name.padEnd(40)} ${status}  ${s.outcome === "rejected" ? s.detail : ""}`);
  }
  console.log(r.ok ? green("\nEvery step behaved as expected.") : yellow("\nSome steps did not behave as expected (marked !)."));
}

async function main(): Promise<number> {
  // `pnpm start -- <cmd>` forwards the `--` itself; drop it so flags still parse.
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      bounty: { type: "string" },
      "mcp-url": { type: "string" },
      payout: { type: "string" },
      wait: { type: "string" },
      dir: { type: "string" },
      "no-llm": { type: "boolean" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd || values.help ? 0 : 1;
  }

  if (cmd === "review") {
    if (!values.dir) throw new Error("--dir is required");
    const llm = values["no-llm"] ? undefined : new AnthropicLlm({ model: values.model });
    const result = await reviewSource(await readSourceTree(values.dir), { llm });
    for (const f of result.findings) {
      const padded = f.severity.padEnd(6);
      const sev = f.severity === "high" ? red(padded) : f.severity === "medium" ? yellow(padded) : padded;
      console.log(`${sev} ${f.source.padEnd(6)} ${f.file}${f.line ? `:${f.line}` : ""}  ${f.message}`);
    }
    console.log(result.pass ? green(result.summary) : red(result.summary));
    return result.pass ? 0 : 2;
  }

  if (cmd !== "adversarial" && cmd !== "broken") throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
  if (!values.bounty) throw new Error("--bounty is required");
  const url = values["mcp-url"] ?? process.env.ABM_MCP_URL ?? DEFAULT_MCP_URL;
  const mcp = await connectHttp(url, `abm-${cmd}`);
  try {
    const opts = {
      bountyId: values.bounty,
      payoutAddress: values.payout ?? DEMO_PAYOUT,
      waitMs: values.wait === undefined ? undefined : Number(values.wait) * 1000,
      log: (line: string) => console.log(line),
    };
    const report = cmd === "adversarial" ? await runAdversarial(mcp, opts) : await runBroken(mcp, opts);
    printReport(report);
    return report.ok ? 0 : 2;
  } finally {
    await mcp.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  },
);
