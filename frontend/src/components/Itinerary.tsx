import type { QuestDetail } from "@/lib/types";

export function Itinerary({ q }: { q: QuestDetail }) {
  return (
    <section aria-labelledby="route-h" className="flex flex-col gap-3">
      <h2 id="route-h" className="h2">Route</h2>
      {q.summary && <p className="max-w-[62ch] text-[16px] leading-relaxed">{q.summary}</p>}
      <ol className="mt-1 border-l-2 border-ink">
        {q.itinerary.map((s, i) => (
          <li key={`${s.time}-${i}`} className="relative flex gap-5 pb-5 pl-5 last:pb-0">
            <span aria-hidden="true" className="absolute -left-[7px] top-[6px] h-3 w-3 rounded-full border-2 border-ink bg-signal" />
            <span className="tab w-[76px] flex-none font-bold">{s.time}</span>
            <div className="min-w-0">
              <div className="font-bold">{s.title}</div>
              {s.detail && <div className="text-[15px] text-muted">{s.detail}</div>}
              {s.note && (
                <div className="mt-2 inline-flex max-w-[52ch] items-start gap-2 rounded bg-stock px-3 py-2 text-[14px]">
                  <span className="font-semibold">Agent note:</span>
                  <span>{s.note}</span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {q.meet_point && (
        <p className="text-[15px]">
          <strong>Meet at</strong> {q.meet_point}
        </p>
      )}
    </section>
  );
}
