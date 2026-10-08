"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

type Trace = { tool: string; input: Record<string, unknown>; output: unknown };
type Turn = { role: "user" | "assistant"; content: string; trace?: Trace[]; approve_url?: string | null };

const TOOL_TEXT: Record<string, string> = {
  list_quests: "Looked at quests",
  get_quest: "Opened a quest",
  hold_spot: "Started a PayPal hold",
  check_my_spot: "Checked your hold",
};

const GREETED = "sidequest.scout.greeted";

/** Scout's face. An original character: a round yellow conductor with a cap. */
export function ScoutFace({ size = 56, blink = true }: { size?: number; blink?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="block">
      <circle cx="32" cy="36" r="24" fill="#ffc93c" stroke="#1a2130" strokeWidth="3" />
      {/* cap */}
      <path d="M13 24 C 16 12, 48 12, 51 24 Z" fill="#1a2130" />
      <rect x="10" y="22" width="44" height="6" rx="3" fill="#1a2130" />
      <circle cx="32" cy="17" r="3" fill="#ffc93c" />
      {/* eyes */}
      <g className={blink ? "scout-blink" : undefined}>
        <ellipse cx="24" cy="37" rx="3" ry="4" fill="#1a2130" />
        <ellipse cx="40" cy="37" rx="3" ry="4" fill="#1a2130" />
      </g>
      {/* cheeks and smile */}
      <circle cx="18" cy="45" r="3.2" fill="#f2a3a3" opacity="0.8" />
      <circle cx="46" cy="45" r="3.2" fill="#f2a3a3" opacity="0.8" />
      <path d="M25 46 Q 32 52 39 46" fill="none" stroke="#1a2130" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A friendly assistant on every page. Same four tools Claude or ChatGPT would get through MCP. */
export function Scout() {
  const path = usePathname();
  const { user, toast } = useSession();
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const questId = path.match(/^\/(?:q|join)\/([^/]+)/)?.[1];
  const suggestions = [
    ...(questId ? ["Tell me about this quest"] : []),
    "Find me something under $90 this weekend",
    "What's happening in Brooklyn?",
    "Did my hold go through?",
  ];

  // Say hello once per visit, a moment after the page settles.
  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(GREETED) === "1";
    } catch {}
    if (seen) return;
    const t = window.setTimeout(() => setBubble(true), 2500);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, busy, open]);

  const dismissBubble = () => {
    setBubble(false);
    try {
      sessionStorage.setItem(GREETED, "1");
    } catch {}
  };

  const send = async (value: string) => {
    const shown = value.trim();
    if (!shown || busy || !user) return;
    // "This quest" means the one on screen. Scout gets the id; the person sees their own words.
    const sent = shown === "Tell me about this quest" && questId
      ? `Tell me about quest ${questId}: who's going, what it costs, and when I'd be charged.`
      : shown;
    const next: Turn[] = [...turns, { role: "user", content: shown }];
    setTurns(next);
    setText("");
    setBusy(true);
    try {
      const history = next.map(({ role, content }, i) => ({ role, content: i === next.length - 1 ? sent : content }));
      const res = await api<{ reply: string; trace: Trace[]; approve_url: string | null }>("/assistant/chat", {
        method: "POST",
        json: { messages: history },
      });
      setTurns([...next, { role: "assistant", content: res.reply, trace: res.trace, approve_url: res.approve_url }]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Scout didn't answer.", "error");
      setTurns(turns);
      setText(shown);
    } finally {
      setBusy(false);
    }
  };

  // The For AI agents page has the full version with the tool trace.
  if (path.startsWith("/agents")) return null;

  return (
    <>
      {!open && (
        <div className="scout-launcher fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 sm:bottom-6 sm:right-6">
          {bubble && (
            <div className="toast relative max-w-[240px] rounded-[16px_16px_4px_16px] border-2 border-ink bg-stock px-4 py-3 text-[14px] leading-snug shadow-[0_4px_0_var(--ink)]">
              <button
                type="button"
                onClick={dismissBubble}
                aria-label="Dismiss"
                className="absolute right-1 top-1 grid h-7 w-7 place-items-center text-[16px] text-muted hover:text-ink"
              >
                ×
              </button>
              <p className="pr-4"><strong>Hi, I'm Scout.</strong> Want a plan for this weekend? I can find one and hold your spot.</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              dismissBubble();
              setOpen(true);
            }}
            aria-label="Ask Scout, your Sidequest assistant"
            className="scout-bob grid h-[68px] w-[68px] place-items-center rounded-full border-2 border-ink bg-stock shadow-[0_5px_0_var(--ink)] transition-transform hover:-translate-y-[2px] active:translate-y-[2px] active:shadow-[0_2px_0_var(--ink)]"
          >
            <ScoutFace size={54} />
          </button>
        </div>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-[rgba(26,33,48,0.25)] sm:bg-transparent" onClick={() => setOpen(false)} aria-hidden="true" />
          <aside
            role="dialog"
            aria-modal="false"
            aria-labelledby="scout-h"
            className="scout-drawer fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col border-t-2 border-ink bg-stock shadow-[0_-6px_0_var(--ink)] sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-4 sm:h-auto sm:w-[400px] sm:rounded-md sm:border-2 sm:shadow-[0_6px_0_var(--ink)]"
          >
            <header className="flex items-center gap-3 border-b-2 border-ink bg-signal px-4 py-3">
              <ScoutFace size={44} />
              <div className="min-w-0 flex-1 leading-tight">
                <div id="scout-h" className="text-[18px] font-extrabold" style={{ fontStretch: "80%" }}>Scout</div>
                <div className="text-[13px]">Finds quests and holds your spot. You approve on PayPal.</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="grid h-9 w-9 place-items-center rounded-full text-[22px] hover:bg-white/50" aria-label="Close Scout">
                ×
              </button>
            </header>

            <div ref={box} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
              {turns.length === 0 && (
                <div className="flex flex-col gap-3">
                  <p className="rounded-[16px_16px_16px_4px] bg-paper px-4 py-3 text-[15px] leading-relaxed">
                    {user ? `Hey ${user.name}! ` : "Hey! "}Tell me what you feel like doing and your budget. I'll find a quest, tell you who's going, and set up the hold. Nothing is charged unless it runs.
                  </p>
                  {!user && <p className="text-[14px] text-muted">Pick who you are in the top right first.</p>}
                </div>
              )}
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="max-w-[85%] self-end rounded-[16px_16px_4px_16px] bg-ink px-4 py-2 text-[15px] text-stock">{t.content}</div>
                ) : (
                  <div key={i} className="flex max-w-[92%] flex-col gap-2">
                    {t.trace && t.trace.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {t.trace.map((c, j) => (
                          <span key={j} className={`chip ${c.tool === "hold_spot" ? "chip-held" : "chip-sim"}`}>{TOOL_TEXT[c.tool] ?? c.tool}</span>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-line rounded-[16px_16px_16px_4px] bg-paper px-4 py-3 text-[15px] leading-relaxed">{t.content}</p>
                    {t.approve_url && (
                      <a href={t.approve_url} target="_blank" rel="noreferrer" className="btn btn-money self-start">
                        Approve the hold on PayPal
                      </a>
                    )}
                  </div>
                ),
              )}
              {busy && (
                <div className="flex items-center gap-2 text-[14px] text-muted"><span className="pulse-dot" /> Scout is looking</div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 px-4 pb-3">
              {suggestions.filter((s) => !turns.some((t) => t.content === s)).slice(0, 3).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy || !user}
                  onClick={() => send(s)}
                  className="min-h-[34px] rounded-full border-2 border-ink px-3 text-left text-[13px] font-semibold hover:bg-ink hover:text-stock disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
            <form className="flex gap-2 border-t-2 border-ink p-3" onSubmit={(e) => { e.preventDefault(); send(text); }}>
              <label htmlFor="ask-scout" className="sr-only">Message Scout</label>
              <input
                id="ask-scout"
                ref={input}
                className="field"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                placeholder={user ? "Ask for plans, or say which one to hold" : "Pick who you are first"}
                disabled={!user}
              />
              <button className="btn btn-ink" type="submit" disabled={busy || !text.trim() || !user}>Send</button>
            </form>
            <p className="px-4 pb-3 text-[12px] text-muted">
              Scout uses the same tools your own AI gets. <Link href="/agents" className="underline" onClick={() => setOpen(false)}>Connect Claude or ChatGPT</Link>
            </p>
          </aside>
        </>
      )}
    </>
  );
}
