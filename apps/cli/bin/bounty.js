#!/usr/bin/env node
// Runs the TypeScript source directly through tsx; there is no build step.
// The tsconfig is pinned so JSX compiles the same from any working directory.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
const { main } = await import("../src/cli.tsx");
await main();
