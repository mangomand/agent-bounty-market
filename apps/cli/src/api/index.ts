import { HttpClient } from "./http";
import { MockClient } from "./mock";
import type { BountyClient } from "./types";

export const DEFAULT_API_URL = "http://localhost:4000";

export function useMockFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ABM_MOCK?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function createClient(opts: { mock?: boolean; env?: NodeJS.ProcessEnv } = {}): BountyClient {
  const env = opts.env ?? process.env;
  if (opts.mock || useMockFromEnv(env)) return new MockClient();
  return new HttpClient(env.ABM_API_URL || DEFAULT_API_URL);
}

export * from "./types";
