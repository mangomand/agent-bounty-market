import { config } from "../config";
import { createHttpClient } from "./http";
import { createMockClient } from "./mock";
import type { ApiClient } from "./types";

export * from "./types";

let client: ApiClient | undefined;

/** The app's API client: in-memory mock when NEXT_PUBLIC_MOCK=1, otherwise HTTP. */
export function api(): ApiClient {
  client ??= config.mock ? createMockClient() : createHttpClient(config.apiUrl);
  return client;
}
