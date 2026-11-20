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

// Anvil's first default account (the demo creator). The connector holds no key: with a real
// Anvil RPC it forwards eth_sendTransaction, and Anvil signs for its own unlocked dev account.
const ANVIL_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const anvilWallet = () => mock({ accounts: [ANVIL_ACCOUNT], features: { reconnect: true } });

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: config.mock
    ? [anvilWallet()]
    : config.devWallet && chain.id === 31337
      ? [anvilWallet(), injected({ target: "metaMask" }), injected()]
      : [injected({ target: "metaMask" }), injected()],
  transports: { [chain.id]: http(config.rpcUrl) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
