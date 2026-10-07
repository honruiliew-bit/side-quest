"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { LineBullet } from "@/components/Avatar";
import { Board } from "@/components/Board";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { CostLine, Draft, Stop } from "@/lib/types";

const EXAMPLES = [
  "Apple picking upstate for 6 people this Saturday",
  "Bakery crawl in Brooklyn on Sunday morning",
  "Surf lesson at Rockaway next weekend",
  "Sunrise hike, train from Grand Central",
];

function priceAt(lines: CostLine[], n: number) {
  const shared = lines.filter((l) => l.split === "shared").reduce((a, l) => a + l.cents, 0);
  const each = lines.filter((l) => l.split !== "shared").reduce((a, l) => a + l.cents, 0);
  return Math.ceil(shared / n) + each;
}

export default function NewQuest() {
  const { user, toast } = useSession();
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const make = async (text: string) => {
    if (!text.trim()) return;
    setDrafting(true);
    try {
      const d = await api<Draft>("/quests/draft", { method: "POST", json: { prompt: text } });
      setDraft(d);
      window.setTimeout(() => document.getElementById("draft")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't draft that.", "error");
    } finally {
      setDrafting(false);
    }
  };

  const publish = async () => {
    if (!draft) return;
    setPublishing(true);
    try {
      const res = await api<{ id: string }>("/quests", { method: "POST", json: draft });
      toast("Published. Hold your own spot to get it started.");
      router.push(`/q/${res.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't publish.", "error");
      setPublishing(false);
    }
  };

  return (
    <>
      <section className="platform" aria-labelledby="new-h">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-col gap-6 px-4 pb-12 pt-10 sm:px-10">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <h1 id="new-h" className="display max-w-[14ch] text-[48px] sm:text-[64px]">Describe the quest. The agent plans it.</h1>
            <Board text={drafting ? "DRAFTING..." : draft ? "DRAFT READY" : "NEW QUEST"} length={11} label="Builder status" />
          </div>
          <form
            className="ticket flex flex-col gap-4 p-5 sm:p-7"
            onSubmit={(e) => {
              e.preventDefault();
              make(prompt);
            }}
          >
            <label htmlFor="prompt" className="h3">One sentence is enough</label>
            <textarea
              id="prompt"
              className="field min-h-[96px] text-[18px]"
              placeholder="Cheap day trip upstate for 6 of us, this Saturday, back by dinner"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={600}
            />
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => { setPrompt(ex); make(ex); }} disabled={drafting}
                  className="min-h-[36px] rounded-full border-2 border-ink px-3 text-[14px] font-semibold hover:bg-ink hover:text-stock disabled:opacity-50">
                  {ex}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <button className="btn btn-ink" type="submit" disabled={drafting || !prompt.trim() || !user}>
                {drafting ? "Drafting" : "Draft it"}
              </button>
              <span className="text-[14px] text-muted">
                The agent picks the date, the stops and an honest cost split. You can change everything before publishing.
              </span>
            </div>
          </form>
        </div>
      </section>

      {draft && <Editor draft={draft} setDraft={setDraft} onPublish={publish} publishing={publishing} hostName={user?.name ?? "you"} />}
    </>
  );
}

function Editor({ draft, setDraft, onPublish, publishing, hostName }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onPublish: () => void;
  publishing: boolean;
  hostName: string;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const setLine = (i: number, patch: Partial<CostLine>) => set("cost_lines", draft.cost_lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setStop = (i: number, patch: Partial<Stop>) => set("itinerary", draft.itinerary.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const tiers = useMemo(() => {
    if (!draft.cost_lines.length || draft.min_people < 1) return [];
    const out = [];
    for (let n = draft.min_people; n <= Math.max(draft.min_people, draft.max_people); n++) out.push({ n, cents: priceAt(draft.cost_lines, n) });
    return out;
  }, [draft.cost_lines, draft.min_people, draft.max_people]);
  const valid = draft.title.trim().length >= 3 && draft.cost_lines.length > 0 && draft.max_people >= draft.min_people && draft.min_people >= 2;

  return (
    <main id="draft" className="mx-auto flex max-w-page scroll-mt-4 flex-wrap items-start gap-10 px-4 pb-24 pt-12 sm:px-10">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-10">
        <div className="flex items-center gap-3">
          <h2 className="h2">Check the draft</h2>
          <span className="rounded-full border border-rule px-2 py-[2px] text-[12px] font-semibold text-muted">
            {draft.source === "claude" ? "Drafted by Claude" : "Drafted offline"}
          </span>
        </div>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">Basics</legend>
          <Field label="Title" className="sm:col-span-2"><input className="field" value={draft.title} onChange={(e) => set("title", e.target.value)} /></Field>
          <Field label="Summary" className="sm:col-span-2"><textarea className="field" rows={2} value={draft.summary} onChange={(e) => set("summary", e.target.value)} /></Field>
          <Field label="Area"><input className="field" value={draft.area} onChange={(e) => set("area", e.target.value)} /></Field>
          <Field label="Line code"><input className="field uppercase" maxLength={2} value={draft.line_code} onChange={(e) => set("line_code", e.target.value.toUpperCase())} /></Field>
          <Field label="From"><input className="field" value={draft.from_label} onChange={(e) => set("from_label", e.target.value)} /></Field>
          <Field label="To"><input className="field" value={draft.to_label} onChange={(e) => set("to_label", e.target.value)} /></Field>
          <Field label="Meet at" className="sm:col-span-2"><input className="field" value={draft.meet_point} onChange={(e) => set("meet_point", e.target.value)} /></Field>
          <Field label="Date"><input className="field" type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Leaves"><input className="field" type="time" value={draft.start_time} onChange={(e) => set("start_time", e.target.value)} /></Field>
            <Field label="Back by"><input className="field" type="time" value={draft.end_time} onChange={(e) => set("end_time", e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Runs at"><input className="field" type="number" min={2} max={30} value={draft.min_people} onChange={(e) => set("min_people", +e.target.value)} /></Field>
            <Field label="Most people"><input className="field" type="number" min={2} max={40} value={draft.max_people} onChange={(e) => set("max_people", +e.target.value)} /></Field>
          </div>
          <Field label="Join deadline, hours before leaving"><input className="field" type="number" min={1} max={336} value={draft.join_by_hours_before} onChange={(e) => set("join_by_hours_before", +e.target.value)} /></Field>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="h3 mb-2">Costs collected up front</legend>
          {draft.cost_lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_120px_150px_44px] items-center gap-2">
              <label className="sr-only" htmlFor={`cl-${i}`}>Cost name</label>
              <input id={`cl-${i}`} className="field" value={l.label} onChange={(e) => setLine(i, { label: e.target.value })} />
              <label className="sr-only" htmlFor={`ca-${i}`}>Amount</label>
              <input id={`ca-${i}`} className="field tab" type="number" min={0} step="0.01" value={l.cents / 100}
                onChange={(e) => setLine(i, { cents: Math.max(0, Math.round(parseFloat(e.target.value || "0") * 100)) })} />
              <label className="sr-only" htmlFor={`cs-${i}`}>Split</label>
              <select id={`cs-${i}`} className="field" value={l.split} onChange={(e) => setLine(i, { split: e.target.value as CostLine["split"] })}>
                <option value="shared">Split by group</option>
                <option value="each">Each person</option>
              </select>
              <button type="button" aria-label={`Remove ${l.label}`} className="grid h-11 w-11 place-items-center rounded border-2 border-ink text-[20px] hover:bg-ink hover:text-stock"
                onClick={() => set("cost_lines", draft.cost_lines.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => set("cost_lines", [...draft.cost_lines, { label: "New cost", cents: 1000, split: "each" }])}>Add a cost</button>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="h3 mb-2">Route</legend>
          {draft.itinerary.map((s, i) => (
            <div key={i} className="grid grid-cols-[110px_1fr_44px] items-start gap-2 sm:grid-cols-[110px_1fr_1fr_44px]">
              <input aria-label="Time" className="field" value={s.time} onChange={(e) => setStop(i, { time: e.target.value })} />
              <input aria-label="Stop" className="field" value={s.title} onChange={(e) => setStop(i, { title: e.target.value })} />
              <input aria-label="Detail" className="field hidden sm:block" value={s.detail} onChange={(e) => setStop(i, { detail: e.target.value })} />
              <button type="button" aria-label={`Remove ${s.title}`} className="grid h-11 w-11 place-items-center rounded border-2 border-ink text-[20px] hover:bg-ink hover:text-stock"
                onClick={() => set("itinerary", draft.itinerary.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => set("itinerary", [...draft.itinerary, { time: "", title: "New stop", detail: "" }])}>Add a stop</button>
        </fieldset>
      </div>

      <aside className="min-w-0 flex-[1_1_340px] lg:sticky lg:top-6">
        <div className="ticket flex flex-col gap-4 p-6">
          <div className="flex items-center gap-3">
            <LineBullet code={draft.line_code || "SQ"} size={40} />
            <span className="text-[14px] text-muted">{draft.area}</span>
          </div>
          <div className="display text-[34px]">{draft.title}</div>
          <div className="text-[15px]">Hosted by {hostName}. Runs at {draft.min_people}, up to {draft.max_people}.</div>
          <div className="border-t-2 border-dashed border-ink pt-4">
            <div className="label">Each person holds</div>
            <div className="tab text-[52px] font-extrabold leading-none text-money" style={{ fontStretch: "62%" }}>
              {tiers[0] ? money(tiers[0].cents) : "$0.00"}
            </div>
            {tiers.length > 1 && (
              <p className="mt-1 text-[14px] text-muted">Drops to {money(tiers[tiers.length - 1].cents)} if {tiers[tiers.length - 1].n} join.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {tiers.slice(0, 8).map((t) => (
              <span key={t.n} className="tab rounded border-2 border-ink px-2 py-1 text-[13px]">{t.n}: {money(t.cents)}</span>
            ))}
          </div>
          <button className="btn btn-ink-signal" disabled={!valid || publishing} onClick={onPublish}>
            {publishing ? "Publishing" : "Publish quest"}
          </button>
          {!valid && <p className="text-[13px] text-stamp">Add a title, at least one cost, and a group size of 2 or more.</p>}
        </div>
      </aside>
    </main>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[14px] font-semibold">{label}</span>
      {children}
    </label>
  );
}
