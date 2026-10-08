"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { Avatar } from "./Avatar";

const NAV = [
  { href: "/", label: "Departures" },
  { href: "/new", label: "Start a quest" },
  { href: "/me", label: "My money" },
];

export function Header() {
  const path = usePathname();
  const { config } = useSession();
  return (
    <header className="bg-ink text-stock">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-signal focus:px-3 focus:py-2 focus:text-ink">
        Skip to content
      </a>
      <div className="mx-auto flex max-w-page flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-10">
        <Link href="/" className="flex items-center gap-2 text-[26px] font-extrabold no-underline" style={{ fontStretch: "72%" }}>
          <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full bg-signal" />
          Sidequest
        </Link>
        <nav aria-label="Main" className="order-3 flex w-full flex-wrap gap-x-6 gap-y-1 text-[15px] font-medium sm:order-none sm:w-auto">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href) || (n.href === "/me" && path.startsWith("/books"));
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`py-2 no-underline ${active ? "text-signal" : "text-stock hover:text-signal"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3">
          {config && (
            <span
              className="hidden rounded-full border border-stock/30 px-3 py-1 text-[12px] font-semibold md:inline-flex"
              title={config.paypal_mode === "sandbox" ? "Real calls to the PayPal sandbox" : "PayPal calls are simulated"}
            >
              {config.paypal_mode === "sandbox" ? "PayPal sandbox" : "Mock PayPal"}
            </span>
          )}
          <DemoMenu />
        </div>
      </div>
    </header>
  );
}

/** One small menu for everything demo-only: who you are playing, and a reset. */
function DemoMenu() {
  const { user, personas, signInAs, signIn, signOut, config, toast } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[44px] items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[14px] hover:bg-white/10"
      >
        {user ? <Avatar user={user} size={34} /> : <span className="h-[34px] w-[34px] rounded-full border-2 border-dashed border-stock/50" />}
        <span className="text-left leading-tight">
          <span className="block text-[11px] text-stock/70">{config?.demo_mode ? "Demo as" : "Signed in"}</span>
          <span className="block font-semibold">{user?.name ?? "Guest"}</span>
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="toast absolute right-0 top-full z-40 mt-2 w-[300px] origin-top-right rounded-md border-2 border-ink bg-stock p-3 text-ink shadow-[0_6px_0_var(--ink)]"
        >
          {personas.length > 0 && (
            <>
              <p className="px-1 pb-2 text-[13px] text-muted">Demo mode. Switch person to play every side of a quest: Hon hosts, everyone else joins.</p>
              <div className="grid grid-cols-2 gap-1">
                {personas.map((p) => (
                  <button
                    key={p.id}
                    role="menuitemradio"
                    aria-checked={user?.id === p.id}
                    type="button"
                    onClick={async () => {
                      await signInAs(p.persona!);
                      setOpen(false);
                      toast(`You're now ${p.name}.`);
                    }}
                    className={`flex min-h-[44px] items-center gap-2 rounded px-2 text-left text-[15px] font-semibold hover:bg-paper ${
                      user?.id === p.id ? "bg-paper" : ""
                    }`}
                  >
                    <Avatar user={p} size={28} />
                    {p.name}
                  </button>
                ))}
              </div>
              <hr className="my-3 border-rule" />
            </>
          )}
          {config?.demo_mode && (
            <button
              type="button"
              className="mb-3 w-full rounded px-2 py-2 text-left text-[14px] font-semibold hover:bg-paper"
              disabled={resetting}
              onClick={async () => {
                setResetting(true);
                try {
                  await api("/demo/reset", { method: "POST" });
                  setOpen(false);
                  toast("Demo data reset.");
                  router.push("/");
                } catch (e) {
                  toast(e instanceof Error ? e.message : "Reset failed.", "error");
                } finally {
                  setResetting(false);
                }
              }}
            >
              {resetting ? "Resetting..." : "Reset all demo data"}
            </button>
          )}
          <details>
          <summary className="cursor-pointer px-1 py-1 text-[13px] font-semibold">Sign in as yourself</summary>
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await signIn(name, email);
                setOpen(false);
              } catch (err) {
                toast(err instanceof Error ? err.message : "Couldn't sign in.", "error");
              }
            }}
          >
            <label className="sr-only" htmlFor="si-name">Name</label>
            <input id="si-name" className="field" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            <label className="sr-only" htmlFor="si-email">Email</label>
            <input id="si-email" className="field" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            <button className="btn btn-ink btn-sm" type="submit">Sign in</button>
          </form>
          </details>
          {user && (
            <button type="button" className="mt-2 w-full py-2 text-[14px] text-muted underline" onClick={() => { signOut(); setOpen(false); }}>
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
