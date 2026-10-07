import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Header } from "@/components/Header";
import { SessionProvider } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sidequest",
  description: "Group adventures that only run when enough people commit. Hold your spot with PayPal. Nobody pays unless it happens.",
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
            <div className="mx-auto flex max-w-page flex-wrap justify-between gap-4 px-4 py-8 text-[14px] text-muted sm:px-10">
              <span>Sidequest. Built for the PayPal AI Hackathon with PayPal Orders, Payments, Payouts, Invoicing and the PayPal Agent Toolkit.</span>
              <span>Holds are PayPal authorizations. You are only charged if the quest runs.</span>
            </div>
          </footer>
        </SessionProvider>
      </body>
    </html>
  );
}
