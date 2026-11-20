#!/usr/bin/env node
// One-command local demo: Anvil → deploy → .env.local → seed bounties → runner + API + web.
// LOCAL ONLY. Uses Anvil's well-known public dev keys; never point this at a real network.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const FOUNDRY_BIN = join(homedir(), ".foundry/bin");
const env0 = { ...process.env, PATH: `${FOUNDRY_BIN}:${process.env.PATH}` };
const TSX = join(ROOT, "node_modules/.bin/tsx");

const RPC_PORT = 8545;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const API_PORT = 4000;
const RUNNER_PORT = 4100;
const WEB_PORT = 3000;

// Anvil's default accounts (public, from the "test test ... junk" mnemonic).
const ANVIL = [
  ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
  ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"],
  ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"],
  ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"],
  ["0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"],
];
const [CREATOR, RUNNER, RELAYER, REVIEWER, DEV] = ANVIL;

const color = process.env.NO_COLOR ? (_c, s) => s : (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const step = (msg) => console.log(color("1", `\n▸ ${msg}`));
const die = (msg) => {
  console.error(color("31", `✗ ${msg}`));
  shutdown(1);
};

const children = [];
function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function start(name, cmd, args, opts) {
  const tag = color("2", `[${name}]`.padEnd(9));
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) if (l.trim()) console.log(`${tag} ${l}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) die(`${name} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

const portOpen = (port) =>
  new Promise((res) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => (s.destroy(), res(true)));
    s.on("error", () => res(false));
  });

async function waitFor(what, check, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  die(`timed out waiting for ${what}`);
}

const has = (bin) => spawnSync("which", [bin], { env: env0 }).status === 0;

// ---------------------------------------------------------------------------------------------

step("Checking tools");
for (const bin of ["anvil", "forge"]) {
  if (!has(bin)) die(`${bin} not found. Install Foundry (see contracts/README.md); it goes in ~/.foundry/bin.`);
}
if (!existsSync(join(ROOT, "node_modules"))) die("run `corepack pnpm install` first");
if (!existsSync(join(ROOT, "contracts/lib/openzeppelin-contracts"))) {
  console.log("installing contract libs…");
  execFileSync(
    "forge",
    ["install", "foundry-rs/forge-std@v1.11.0", "OpenZeppelin/openzeppelin-contracts@v5.1.0", "--no-git"],
    { cwd: join(ROOT, "contracts"), env: env0, stdio: "inherit" },
  );
}
for (const [port, name] of [[RPC_PORT, "Anvil"], [API_PORT, "API"], [RUNNER_PORT, "runner"], [WEB_PORT, "web"]]) {
  if (await portOpen(port)) die(`port ${port} (${name}) is already in use. Stop whatever is running there and retry.`);
}

let backend = "docker";
if (spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0) {
  console.log(color("32", "✓ Docker is available: submissions run in the Docker sandbox"));
  const image = "node:22-bookworm-slim";
  if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
    console.log(`pulling ${image}…`);
    execFileSync("docker", ["pull", image], { stdio: "inherit" });
  }
} else {
  backend = "process";
  console.log(
    color(
      "33",
      [
        "",
        "!! Docker is not available (`docker info` failed).",
        "!! Falling back to RUNNER_BACKEND=process: submitted code runs UNSANDBOXED on this machine.",
        "!! Only submit code you trust. Start Docker (e.g. `colima start`) for real sandboxing.",
      ].join("\n"),
    ),
  );
}

step("Starting Anvil (chain 31337)");
start("anvil", "anvil", ["--port", String(RPC_PORT), "--silent"], { env: env0 });
await waitFor("Anvil", () => portOpen(RPC_PORT));

step("Deploying MockUSDC + BountyEscrow");
const deployOut = execFileSync(
  "forge",
  ["script", "script/Deploy.s.sol", "--rpc-url", RPC_URL, "--broadcast", "--private-key", CREATOR[1]],
  {
    cwd: join(ROOT, "contracts"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env0, RUNNER_SIGNER_ADDRESS: RUNNER[0], REVIEWER_SIGNER_ADDRESS: REVIEWER[0] },
  },
);
const USDC = deployOut.match(/USDC_ADDRESS=(0x[0-9a-fA-F]{40})/)?.[1];
const ESCROW = deployOut.match(/BOUNTY_CONTRACT_ADDRESS=(0x[0-9a-fA-F]{40})/)?.[1];
if (!USDC || !ESCROW) die(`could not read deployed addresses:\n${deployOut}`);
console.log(`MockUSDC     ${USDC}\nBountyEscrow ${ESCROW}`);

step("Writing .env.local");
const dbPath = join(ROOT, "apps/api/data/demo.db");
const envFile = join(ROOT, ".env.local");
const HEADER = "# Written by `corepack pnpm demo`.";
if (existsSync(envFile) && !readFileSync(envFile, "utf8").startsWith(HEADER)) {
  renameSync(envFile, `${envFile}.bak`);
  console.log("existing .env.local moved to .env.local.bak");
}
const vars = {
  RPC_URL,
  CHAIN_ID: "31337",
  BOUNTY_CONTRACT_ADDRESS: ESCROW,
  USDC_ADDRESS: USDC,
  // Runner process only: signs build/test (RUNNER_ROLE) and security (REVIEWER_ROLE) receipts.
  RUNNER_SIGNER_PRIVATE_KEY: RUNNER[1],
  REVIEWER_SIGNER_PRIVATE_KEY: REVIEWER[1],
  RUNNER_BACKEND: backend,
  RUNNER_PORT: String(RUNNER_PORT),
  // API only: pays gas to relay submitCode/submitReceipt. Holds no role; cannot move funds.
  RELAYER_PRIVATE_KEY: RELAYER[1],
  // Seed script only: funds the demo bounties as the creator.
  CREATOR_PRIVATE_KEY: CREATOR[1],
  API_PORT: String(API_PORT),
  API_DB_PATH: dbPath,
  RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
  RUNNER_SIGNER_ADDRESSES: `${RUNNER[0]},${REVIEWER[0]}`,
  WEB_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
  NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
  NEXT_PUBLIC_RPC_URL: RPC_URL,
  NEXT_PUBLIC_MOCK: "0",
  NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS: ESCROW,
  NEXT_PUBLIC_USDC_ADDRESS: USDC,
};
writeFileSync(
  envFile,
  `${HEADER} Local Anvil only: these are Anvil's PUBLIC dev keys.\n` +
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") +
    "\n",
);
const env = { ...env0, ...vars };

step("Seeding demo bounties onchain and in the API database");
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
execFileSync(TSX, ["apps/api/src/seed-onchain.ts"], { cwd: ROOT, env, stdio: "inherit" });

step("Starting runner, API, and web");
start("runner", TSX, ["packages/runner/src/main.ts"], { cwd: ROOT, env });
await waitFor("runner", () => portOpen(RUNNER_PORT));
start("api", TSX, ["apps/api/src/index.ts"], { cwd: ROOT, env });
await waitFor("API", () => fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.ok));
start("web", join(ROOT, "apps/web/node_modules/.bin/next"), ["dev", "-p", String(WEB_PORT)], { cwd: join(ROOT, "apps/web"), env });
await waitFor("web", () => portOpen(WEB_PORT), 120_000);

console.log(
  [
    "",
    color("32", "✓ Demo is running"),
    `  Web (creator)   http://localhost:${WEB_PORT}`,
    `  API             http://localhost:${API_PORT}    live events: curl -N http://localhost:${API_PORT}/events`,
    `  MCP (agents)    claude mcp add --transport http bounty http://localhost:${API_PORT}/mcp`,
    `  Chain           ${RPC_URL} (chain id 31337)    sandbox: ${backend}`,
    "",
    "  Creator wallet: import Anvil account #0 into MetaMask and add the network above.",
    `    ${CREATOR[0]}  (holds the demo USDC, created the seeded bounties)`,
    `  Payout address for agents: Anvil account #4 ${DEV[0]}`,
    "",
    "  Ctrl+C stops everything.",
  ].join("\n"),
);
