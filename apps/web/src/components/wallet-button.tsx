"use client";

import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { Button } from "@/components/ui/button";
import { shortHex } from "@/lib/format";
import { chain } from "@/lib/wagmi";

export function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** Connects the first available connector (MetaMask, any injected wallet, or the mock wallet). */
export function useConnectWallet() {
  const { connect, connectors, isPending, error } = useConnect();
  const connector = connectors[0];
  return {
    connect: () => connector && connect({ connector, chainId: chain.id }),
    isPending,
    error,
  };
}

export function WalletButton({ className }: { className?: string }) {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { connect, isPending } = useConnectWallet();

  if (!mounted) {
    return (
      <Button variant="outline" size="sm" className={className} disabled>
        <Wallet /> Connect wallet
      </Button>
    );
  }

  if (isConnected && address && chainId !== chain.id) {
    return (
      <Button size="sm" className={className} disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </Button>
    );
  }

  if (isConnected && address) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={className}
        title="Disconnect"
        onClick={() => disconnect()}
      >
        <span className="size-2 rounded-full bg-success" aria-hidden />
        <span className="font-mono">{shortHex(address)}</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" className={className} disabled={isPending} onClick={connect}>
      <Wallet /> {isPending ? "Connecting…" : "Connect wallet"}
    </Button>
  );
}
