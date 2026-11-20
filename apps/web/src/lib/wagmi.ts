import { http, createConfig } from "wagmi";
import { anvil } from "wagmi/chains";
// Import from @wagmi/core: the wagmi/connectors barrel pulls in every wallet SDK.
import { injected, mock } from "@wagmi/core";
import { config } from "./config";

/** Local Anvil (chain id 31337). RPC comes from NEXT_PUBLIC_RPC_URL. */
export const chain = {
  ...anvil,
  rpcUrls: { default: { http: [config.rpcUrl] } },
} as const;

// Anvil's first default account. Only used by the mock connector; it signs nothing.
const MOCK_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: config.mock
    ? [mock({ accounts: [MOCK_ACCOUNT], features: { reconnect: true } })]
    : [injected({ target: "metaMask" }), injected()],
  transports: { [chain.id]: http(config.rpcUrl) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
