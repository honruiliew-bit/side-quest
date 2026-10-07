"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { api, API_URL } from "@/lib/api";
import { useSession } from "@/lib/session";

type Trace = { tool: string; input: Record<string, unknown>; output: unknown };
type Turn = { role: "user" | "assistant"; content: string; trace?: Trace[]; approve_url?: string | null; engine?: string };

const SUGGESTIONS = [
  "Find me something under $90 to do this weekend",
  "Anything happening in Brooklyn?",
  "Hold a spot on the apple picking trip",
  "Did my hold go through?",
];

const TOOL_TEXT: Record<string, string> = {
  list_quests: "Searched quests",
  get_quest: "Opened a quest",
  hold_spot: "Started a PayPal hold",
  check_my_spot: "Checked your hold",
};

export default function Agents() {
  const { config } = useSession();
  const url = config?.mcp_url ?? `${API_URL}/mcp/`;
  return (
    <>
      <section className="platform" aria-labelledby="agents-h">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-col gap-8 px-4 pb-12 pt-10 sm:px-10">
          <div className="max-w-[720px]">
            <h1 id="agents-h" className="display text-[48px] sm:text-[68px]">Let your AI assistant book a quest.</h1>
            <p className="mt-4 max-w-[58ch] text-[18px] leading-relaxed">
              Connect Sidequest to Claude or ChatGPT and ask for plans in plain words. Your assistant finds a quest and
              starts the hold. You approve every hold on PayPal, so it can never spend without you.
            </p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-3">
            {[
              { t: "Connect", d: "Add Sidequest to your assistant with one link." },
              { t: "Ask", d: "“Find me something cheap to do Saturday.”" },
              { t: "Approve on PayPal", d: "Your assistant sends a PayPal link. Nothing is held until you approve it." },
            ].map((s, i) => (
              <li key={s.t} className="ticket flex items-start gap-3 p-4">
                <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-ink font-black text-signal" style={{ fontStretch: "62%" }}>{i + 1}</span>
                <div>
                  <div className="font-bold">{s.t}</div>
                  <div className="text-[14px] text-muted">{s.d}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <main className="mx-auto flex max-w-page flex-col gap-16 px-4 pt-12 sm:px-10">
        <TryIt />
        <Connect url={url} />
        <Safety />
      </main>
    </>
  );
}

function TryIt() {
  const { user, toast } = useSession();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const lastTrace = [...turns].reverse().find((t) => t.trace?.length)?.trace ?? [];
  const engine = [...turns].reverse().find((t) => t.engine)?.engine;

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, busy]);

  const send = async (value: string) => {
    const t = value.trim();
    if (!t || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: t }];
    setTurns(next);
    setText("");
    setBusy(true);
    try {
      const res = await api<{ reply: string; trace: Trace[]; approve_url: string | null; engine: string }>("/assistant/chat", {
        method: "POST",
        json: { messages: next.map(({ role, content }) => ({ role, content })) },
      });
      setTurns([...next, { role: "assistant", content: res.reply, trace: res.trace, approve_url: res.approve_url, engine: res.engine }]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "The assistant didn't answer.", "error");
      setTurns(turns);
      setText(t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="try-h" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="try-h" className="h2">Try it here</h2>
          <p className="mt-2 max-w-[62ch] text-[16px] leading-relaxed">
            This is an AI assistant with Sidequest connected, using exactly the tools Claude or ChatGPT would get. Ask it
            something, then watch what it does on the right.
          </p>
        </div>
        {user && (
          <span className="flex items-center gap-2 text-[14px] text-muted">
            <Avatar user={user} size={28} /> Chatting as {user.name}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-stretch gap-6">
        <div className="panel flex min-w-0 flex-[999_1_480px] flex-col">
          <div className="flex items-center justify-between border-b-2 border-ink px-5 py-3">
            <span className="font-bold">Your assistant</span>
            <span className="rounded-full border border-rule px-2 py-[2px] text-[12px] font-semibold text-muted">
              Sidequest connected{engine ? `, ${engine === "claude" ? "Claude" : "offline mode"}` : ""}
            </span>
          </div>
          <div ref={box} className="flex min-h-[320px] max-h-[460px] flex-col gap-4 overflow-y-auto p-5" aria-live="polite">
            {turns.length === 0 && (
              <div className="flex flex-col gap-3">
                <p className="text-[15px] text-muted">Start with one of these, or type your own.</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.slice(0, 3).map((s) => (
                    <button key={s} type="button" onClick={() => send(s)}
                      className="min-h-[40px] rounded-full border-2 border-ink px-4 text-left text-[14px] font-semibold hover:bg-ink hover:text-stock">
                      {s}
                    </button>
                  ))}
                </div>
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
              <div className="flex items-center gap-2 text-[14px] text-muted"><span className="pulse-dot" /> Using Sidequest</div>
            )}
          </div>
          {turns.length > 0 && (
            <div className="flex flex-wrap gap-2 px-5 pb-3">
              {SUGGESTIONS.filter((s) => !turns.some((t) => t.content === s)).slice(0, 3).map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => send(s)}
                  className="min-h-[34px] rounded-full border-2 border-ink px-3 text-[13px] font-semibold hover:bg-ink hover:text-stock disabled:opacity-50">
                  {s}
                </button>
              ))}
            </div>
          )}
          <form className="flex gap-2 border-t-2 border-ink p-3" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <label htmlFor="ask-assistant" className="sr-only">Message your assistant</label>
            <input id="ask-assistant" className="field" value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
              placeholder={user ? "Ask for plans, or say which one to hold" : "Pick who you are in the top right first"} disabled={!user} />
            <button className="btn btn-ink" type="submit" disabled={busy || !text.trim() || !user}>Send</button>
          </form>
        </div>

        <aside className="panel flex min-w-0 flex-[1_1_320px] flex-col" aria-labelledby="trace-h">
          <div className="border-b-2 border-ink px-5 py-3">
            <span id="trace-h" className="font-bold">What the assistant did</span>
          </div>
          <div className="flex flex-1 flex-col gap-3 p-5">
            {lastTrace.length === 0 ? (
              <p className="text-[15px] text-muted">
                Each call your assistant makes to Sidequest shows up here, with what it sent and what came back.
              </p>
            ) : (
              lastTrace.map((c, i) => (
                <details key={i} className="rounded border-2 border-ink bg-white" open={c.tool === "hold_spot"}>
                  <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2">
                    <span className="font-bold">{TOOL_TEXT[c.tool] ?? c.tool}</span>
                    <code className="text-[12px] text-muted">{c.tool}</code>
                  </summary>
                  <div className="flex flex-col gap-2 border-t border-rule p-3 text-[12px]">
                    <div>
                      <div className="label">Sent</div>
                      <pre className="whitespace-pre-wrap break-words">{JSON.stringify(c.input, null, 2)}</pre>
                    </div>
                    <div>
                      <div className="label">Got back</div>
                      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(c.output, null, 2)}</pre>
                    </div>
                  </div>
                </details>
              ))
            )}
            <p className="mt-auto text-[13px] text-muted">
              The assistant only has four tools: list_quests, get_quest, hold_spot and check_my_spot. None of them can move
              money.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

const CLIENTS = ["Claude", "Claude Desktop", "ChatGPT", "Other"] as const;

function Connect({ url }: { url: string }) {
  const { toast } = useSession();
  const [tab, setTab] = useState<(typeof CLIENTS)[number]>("Claude");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const desktop = JSON.stringify({ mcpServers: { sidequest: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2);
  const copy = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      toast("Copied.");
    } catch {
      toast("Copy didn't work. Select the text instead.", "error");
    }
  };

  const steps: Record<(typeof CLIENTS)[number], React.ReactNode[]> = {
    Claude: [
      <>Open <strong>Settings</strong>, then <strong>Connectors</strong>.</>,
      <>Choose <strong>Add custom connector</strong>. Name it Sidequest and paste the link above.</>,
      <>In a new chat, turn Sidequest on from the tools menu and ask for plans.</>,
    ],
    "Claude Desktop": [
      <>Open Claude Desktop settings, then <strong>Developer</strong>, then <strong>Edit config</strong>.</>,
      <>Paste the config below into <code>claude_desktop_config.json</code> and save.</>,
      <>Restart Claude Desktop. Sidequest shows up in the tools menu.</>,
    ],
    ChatGPT: [
      <>Open <strong>Settings</strong>, find the connectors section, and turn on <strong>Developer mode</strong> under advanced settings.</>,
      <>Create a new connector, paste the link above and choose no authentication.</>,
      <>In a new chat, add Sidequest from the tools menu and ask for plans.</>,
    ],
    Other: [
      <>Sidequest speaks MCP over streamable HTTP. No sign-in is needed.</>,
      <>Point your client at the link above.</>,
      <>Four tools appear: list_quests, get_quest, hold_spot and check_my_spot.</>,
    ],
  };

  return (
    <section aria-labelledby="connect-h" className="flex flex-col gap-5">
      <div>
        <h2 id="connect-h" className="h2">Connect your own assistant</h2>
        <p className="mt-2 text-[16px]">Menu names change from time to time. If something looks different, look for connectors or MCP servers.</p>
      </div>
      <div className="panel flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-2">
          <span className="text-[14px] font-semibold">Sidequest connector link</span>
          <div className="flex gap-2">
            <code className="field flex min-w-0 items-center overflow-x-auto whitespace-nowrap text-[14px]">{url}</code>
            <button className="btn btn-ink btn-sm" onClick={() => copy(url)}>Copy</button>
          </div>
          {local && (
            <p className="rounded border-2 border-stamp bg-white p-3 text-[14px]">
              This link points at your own computer, so Claude on the web and ChatGPT can&apos;t reach it. Deploy the backend
              first, or use Claude Desktop, which connects through your computer.
            </p>
          )}
        </div>
        <div role="tablist" aria-label="Assistant" className="flex flex-wrap gap-2">
          {CLIENTS.map((c) => (
            <button key={c} role="tab" aria-selected={tab === c} onClick={() => setTab(c)}
              className={`min-h-[40px] rounded-full border-2 border-ink px-4 text-[14px] font-semibold ${tab === c ? "bg-ink text-signal" : "hover:bg-white"}`}>
              {c}
            </button>
          ))}
        </div>
        <ol role="tabpanel" className="flex flex-col gap-3">
          {steps[tab].map((s, i) => (
            <li key={i} className="flex gap-3 text-[15px] leading-relaxed">
              <span className="grid h-7 w-7 flex-none place-items-center rounded-full border-2 border-ink text-[13px] font-bold">{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        {tab === "Claude Desktop" && (
          <div className="flex flex-col gap-2">
            <pre className="overflow-x-auto rounded border-2 border-ink bg-white p-3 text-[13px] leading-relaxed">{desktop}</pre>
            <button className="btn btn-ghost btn-sm self-start" onClick={() => copy(desktop)}>Copy config</button>
          </div>
        )}
      </div>
    </section>
  );
}

function Safety() {
  return (
    <section aria-labelledby="safe-h" className="flex flex-col gap-4">
      <h2 id="safe-h" className="h2">Why it&apos;s safe to let an assistant do this</h2>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="panel p-5">
          <h3 className="h3">It can&apos;t spend</h3>
          <p className="mt-2 text-[15px] leading-relaxed">hold_spot only creates a PayPal order. Nothing is held until you approve it on PayPal&apos;s own page.</p>
        </div>
        <div className="panel p-5">
          <h3 className="h3">A hold isn&apos;t a charge</h3>
          <p className="mt-2 text-[15px] leading-relaxed">Even after you approve, you&apos;re only charged the final split if the quest runs.</p>
        </div>
        <div className="panel p-5">
          <h3 className="h3">Read-only otherwise</h3>
          <p className="mt-2 text-[15px] leading-relaxed">The other tools only read quests and your hold. Leaving, refunds and payouts stay in Sidequest.</p>
        </div>
      </div>
    </section>
  );
}
