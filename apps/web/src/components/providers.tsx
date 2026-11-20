"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { WagmiProvider, useAccountEffect, useConnect } from "wagmi";
import { config } from "@/lib/config";
import { chain, wagmiConfig } from "@/lib/wagmi";

const MOCK_WALLET_KEY = "abm.mockWalletConnected";

/** The mock connector forgets its connection on reload; restore it so mock demos survive refreshes. */
function MockWalletPersistence() {
  const { connect, connectors } = useConnect();
  useAccountEffect({
    onConnect: () => {
      try {
        localStorage.setItem(MOCK_WALLET_KEY, "1");
      } catch {
        // Storage unavailable; the wallet just won't reconnect after reload.
      }
    },
    onDisconnect: () => {
      try {
        localStorage.removeItem(MOCK_WALLET_KEY);
      } catch {
        // Ignore.
      }
    },
  });
  useEffect(() => {
    let remembered = false;
    try {
      remembered = localStorage.getItem(MOCK_WALLET_KEY) === "1";
    } catch {
      // Ignore.
    }
    const connector = connectors[0];
    if (remembered && connector) connect({ connector, chainId: chain.id });
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {config.mock && <MockWalletPersistence />}
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
