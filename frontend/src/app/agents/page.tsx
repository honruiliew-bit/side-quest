"use client";

import { useEffect, useState } from "react";
import { Board } from "@/components/Board";
import { API_URL } from "@/lib/api";
import { useSession } from "@/lib/session";

type Tool = { name: string; description: string };

export default function Agents() {
  const { config, toast } = useSession();
  const [tools, setTools] = useState<Tool[] | null>(null);
  const url = config?.mcp_url ?? `${API_URL}/mcp/`;

  useEffect(() => {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    (async () => {
      try {
        await fetch(`${API_URL}/mcp/`, { method: "POST", headers, body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sidequest-web", version: "1" } },
        }) });
        const res = await fetch(`${API_URL}/mcp/`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
        const data = await res.json();
        setTools(data.result.tools);
      } catch {
        setTools([]);
      }
    })();
  }, []);

  const desktop = JSON.stringify({ mcpServers: { sidequest: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      toast("Copy didn't work. Select the text instead.", "error");
    }
  };

  return (
    <>
      <section className="platform">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-wrap items-end justify-between gap-6 px-4 pb-12 pt-10 sm:px-10">
          <div className="max-w-[680px]">
            <h1 className="display text-[48px] sm:text-[68px]">Your AI assistant can join quests for you.</h1>
            <p className="mt-4 max-w-[56ch] text-[18px] leading-relaxed">
              Sidequest is an MCP server. Claude, ChatGPT or any MCP client can search departures and start a hold. The person
              still approves every hold on PayPal, so an agent can commit you to a plan but never spends without you.
            </p>
          </div>
          <Board text="AGENTS OK" size="lg" />
        </div>
      </section>

      <main className="mx-auto flex max-w-page flex-col gap-12 px-4 pt-12 sm:px-10">
        <section className="flex flex-col gap-4" aria-labelledby="connect-h">
          <h2 id="connect-h" className="h2">Connect</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="panel flex flex-col gap-3 p-5">
              <h3 className="h3">As a custom connector</h3>
              <p className="text-[15px]">In Claude or ChatGPT, add a custom connector and paste this URL.</p>
              <div className="flex gap-2">
                <code className="field flex items-center overflow-x-auto whitespace-nowrap text-[14px]">{url}</code>
                <button className="btn btn-ink btn-sm" onClick={() => copy(url)}>Copy</button>
              </div>
            </div>
            <div className="panel flex flex-col gap-3 p-5">
              <h3 className="h3">In Claude Desktop</h3>
              <p className="text-[15px]">Add this to claude_desktop_config.json and restart.</p>
              <pre className="overflow-x-auto rounded border-2 border-ink bg-white p-3 text-[13px] leading-relaxed">{desktop}</pre>
              <button className="btn btn-ghost btn-sm self-start" onClick={() => copy(desktop)}>Copy config</button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="tools-h">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="tools-h" className="h2">Tools</h2>
            <span className="text-[14px] text-muted">{tools ? "Read live from the server" : "Loading"}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {(tools ?? []).map((t) => (
              <div key={t.name} className="panel p-5">
                <div className="font-bold">{t.name}</div>
                <p className="mt-1 text-[15px] leading-relaxed text-muted">{t.description}</p>
              </div>
            ))}
            {tools && tools.length === 0 && <p className="text-[15px]">Couldn't reach the MCP endpoint. Is the backend running?</p>}
          </div>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="ex-h">
          <h2 id="ex-h" className="h2">What it looks like</h2>
          <div className="panel flex max-w-[760px] flex-col gap-4 p-6 text-[16px] leading-relaxed">
            <p><strong>You:</strong> Find me something cheap to do this Saturday outside the city, under $90.</p>
            <p className="rounded bg-paper px-4 py-3">
              <strong>Assistant:</strong> Apple picking and cider in the Hudson Valley leaves Saturday at 8:10 am. Four of five
              people are in. The most you'd pay is $81.00, and it drops to $67.29 if the van fills. Want me to hold a spot?
            </p>
            <p><strong>You:</strong> Yes, hold one for me.</p>
            <p className="rounded bg-paper px-4 py-3">
              <strong>Assistant:</strong> Done. Approve the $81.00 hold on PayPal with this link. You won't be charged unless the
              quest runs.
            </p>
            <p className="text-[14px] text-muted">The assistant calls list_quests, then hold_spot. The hold only exists after you approve it on PayPal.</p>
          </div>
        </section>
      </main>
    </>
  );
}
