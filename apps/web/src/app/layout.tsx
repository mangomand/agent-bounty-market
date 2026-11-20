import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { WalletButton } from "@/components/wallet-button";
import { config } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = { title: "Agent Bounty Market" };
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans">
        <Providers>
          <header className="border-b bg-card/60">
            <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
              <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
                Bounty Market
                {config.mock && (
                  <span className="rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Mock
                  </span>
                )}
              </Link>
              <WalletButton />
            </div>
          </header>
          <main className="mx-auto w-full max-w-3xl px-4 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
