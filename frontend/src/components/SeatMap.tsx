import { money } from "@/lib/format";
import type { Membership, QuestDetail } from "@/lib/types";

function chipFor(m: Membership): { cls: string; text: string } {
  switch (m.status) {
    case "held":
      return { cls: "chip-held", text: `Held ${money(m.hold_cents)}` };
    case "charged":
      return m.refunded_cents
        ? { cls: "chip-refund", text: `Paid ${money(m.charged_cents - m.refunded_cents)}` }
        : { cls: "chip-paid", text: `Paid ${money(m.charged_cents)}` };
    case "standby":
      return { cls: "chip-held", text: `Standby ${money(m.hold_cents)}` };
    default:
      return { cls: "chip-released", text: m.status };
  }
}

export function SeatMap({ q }: { q: QuestDetail }) {
  const me = q.viewer.membership?.id;
  const need = Math.max(0, q.min_people - q.headcount);
  const joinable = q.status === "open" || q.status === "on";
  const status =
    q.status === "open"
      ? `${q.headcount} of ${q.min_people} needed. ${need} more and it runs.`
      : q.status === "on"
        ? `It's on. ${q.headcount} going, everyone pays ${money(q.share_cents)}.`
        : q.status === "locked" || q.status === "completed"
          ? `${q.headcount} going. Everyone paid ${money(q.share_cents)}.`
          : "This quest didn't run.";

  return (
    <section aria-labelledby="seats-h" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="seats-h" className="h2">Seats</h2>
        <p aria-live="polite" className="text-[17px] font-semibold">{status}</p>
      </div>
      <div className="panel flex flex-wrap gap-3 p-5" style={{ borderRadius: "28px 6px 6px 28px" }}>
        {q.seats.map((s) => {
          const m = s.member;
          const chip = m ? chipFor(m) : null;
          return (
            <div
              key={s.seat}
              className="flex w-[100px] flex-col items-center gap-[6px]"
              style={s.is_minimum && q.min_people < q.max_people ? { borderRight: "3px solid var(--stamp)", paddingRight: 12, width: 112 } : undefined}
            >
              <div
                key={m?.id ?? `empty-${s.seat}`}
                className={`seat-box ${m ? "seat-filled" : "seat-empty"} ${m && m.id === me ? "seat-you" : ""}`}
                aria-label={m ? `Seat ${s.seat}, ${m.user.name}` : `Seat ${s.seat}, open`}
              >
                {m ? m.user.initials : s.seat}
              </div>
              <div className="min-h-[18px] text-[13px] font-semibold">
                {m ? (m.id === me ? `${m.user.name} (you)` : m.user.name) : !joinable ? "Empty" : s.is_minimum ? "Runs from here" : "Open"}
              </div>
              {chip ? (
                <span className={`chip tab ${chip.cls}`}>{chip.text}</span>
              ) : (
                <span className="min-h-[22px]" />
              )}
              {m?.provider === "sim" && <span className="text-[11px] text-muted">Simulated</span>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px] text-muted">
        <span>Seat {q.min_people} is the minimum. The quest runs once it fills.</span>
        {q.max_people > q.min_people && <span>Every seat after that lowers everyone's share.</span>}
        {q.standby.length > 0 && (
          <span className="flex flex-wrap items-center gap-2 text-ink">
            <strong>Standby:</strong>
            {q.standby.map((m) => (
              <span key={m.id} className="chip chip-held tab">
                {m.user.name}, held {money(m.hold_cents)}
              </span>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}
