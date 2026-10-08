import type { Metadata, Viewport } from "next";
import "./globals.css";
import Link from "next/link";
import { Header } from "@/components/Header";
import { SessionProvider } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sidequest",
  description: "Nobody pays unless the quest runs. Hold your spot with PayPal; you are only charged the real split once enough people commit.",
};

export const viewport: Viewport = { themeColor: "#1a2130", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <Header />
          <div id="main">{children}</div>
          <footer className="mt-16 border-t-2 border-ink">
            <div className="mx-auto flex max-w-page flex-col gap-4 px-4 py-8 text-[14px] text-muted sm:px-10">
              <p className="text-[16px] font-semibold text-ink">Nobody pays unless the quest runs.</p>
              <nav aria-label="More" className="flex flex-wrap gap-x-6 gap-y-2">
                <Link href="/agents" className="text-ink underline">For AI agents (MCP)</Link>
                <a href="https://github.com/honruiliew-bit/side-quest" className="text-ink underline">Source on GitHub</a>
              </nav>
              <p>Built for the PayPal AI Hackathon with PayPal Orders, Payments, Payouts, Invoicing, the Agent Toolkit, Claude, AG Studio and Render.</p>
            </div>
          </footer>
        </SessionProvider>
      </body>
    </html>
  );
}
