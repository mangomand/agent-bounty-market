import { Writable } from "node:stream";
import { Command, Option } from "commander";
import { render } from "ink";
import type { ReactElement } from "react";
import { AGENTS, findAgent } from "./agents";
import { createClient, type BountyClient } from "./api";
import { ErrorLine } from "./ui/components";
import { ListView } from "./ui/views/List";
import { ReceiptsView } from "./ui/views/Receipts";
import { RunView } from "./ui/views/Run";
import { ShowView } from "./ui/views/Show";
import { WatchView } from "./ui/views/Watch";

/** Terminal width: COLUMNS wins (so `COLUMNS=80` works), then the TTY, then 80. */
export function terminalWidth(): number {
  return Number(process.env.COLUMNS) || process.stdout.columns || 80;
}

/**
 * In a terminal, Ink redraws in place (spinners, live progress). When output
 * is piped or captured, only the final frame is printed, with no cursor codes.
 */
async function mount(element: ReactElement): Promise<void> {
  const tty = Boolean(process.stdout.isTTY);
  let lastFrame = "";
  const capture = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        // Unmounting renders an empty tree; keep the last real frame.
        const text = chunk.toString();
        if (text.trim()) lastFrame = text;
        cb();
      },
    }),
    { columns: terminalWidth(), rows: 1000 },
  );
  const app = render(
    element,
    tty
      ? { exitOnCtrlC: true, patchConsole: false }
      : { stdout: capture as unknown as NodeJS.WriteStream, debug: true, patchConsole: false },
  );
  try {
    await app.waitUntilExit();
  } catch {
    // The view already rendered the error.
    process.exitCode ||= 1;
  }
  if (!tty) process.stdout.write(lastFrame.replace(/\n*$/, "\n"));
}

export function buildProgram(): Command {
  const program = new Command("bounty")
    .description("Browse bounties, run agents, and watch submissions get verified and paid.")
    .addOption(new Option("--mock", "use built-in demo data instead of the API (or ABM_MOCK=1)"))
    .addHelpText(
      "after",
      `
Environment:
  ABM_API_URL   API base URL (default http://localhost:4000)
  ABM_MOCK=1    same as --mock
  NO_COLOR=1    disable color`,
    );

  const client = (): BountyClient => createClient({ mock: program.opts<{ mock?: boolean }>().mock });

  program
    .command("list")
    .description("list bounties")
    .action(() => mount(<ListView client={client()} width={terminalWidth()} />));

  program
    .command("show <bountyId>")
    .description("bounty spec and its submissions")
    .action((id: string) => mount(<ShowView client={client()} bountyId={id} width={terminalWidth()} />));

  program
    .command("run <bountyId>")
    .description("start a demo agent on a bounty and follow its submission")
    .addOption(
      new Option("-a, --agent <name>", "agent to run").choices(AGENTS.map((a) => a.id)).default("test-focused"),
    )
    .action((id: string, opts: { agent: string }) => {
      const agent = findAgent(opts.agent);
      if (!agent) return mount(<ErrorLine message={`Unknown agent ${opts.agent}`} />);
      return mount(<RunView client={client()} agent={agent} bountyId={id} width={terminalWidth()} />);
    });

  program
    .command("watch <bountyId>")
    .description("live view of submissions moving through the workflow")
    .option("--follow", "keep watching after the bounty settles")
    .action((id: string, opts: { follow?: boolean }) =>
      mount(<WatchView client={client()} bountyId={id} width={terminalWidth()} exitWhenSettled={!opts.follow} />),
    );

  program
    .command("receipts <submissionId>")
    .description("signed evidence receipts for a submission")
    .action((id: string) => mount(<ReceiptsView client={client()} submissionId={id} width={terminalWidth()} />));

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}
