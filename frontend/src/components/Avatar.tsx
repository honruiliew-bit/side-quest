import type { UserLite } from "@/lib/types";

export function Avatar({ user, size = 36, ring }: { user: UserLite; size?: number; ring?: boolean }) {
  return (
    <span
      title={user.name}
      className="inline-grid shrink-0 place-items-center rounded-full border-2 border-ink font-bold text-ink"
      style={{
        width: size,
        height: size,
        background: user.color,
        fontSize: Math.max(11, Math.round(size * 0.36)),
        fontStretch: "80%",
        boxShadow: ring ? "0 0 0 2px var(--stock), 0 0 0 4px var(--money)" : undefined,
      }}
    >
      {user.initials}
    </span>
  );
}

export function LineBullet({ code, size = 40 }: { code: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-full bg-ink font-black text-signal"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), fontStretch: "62%" }}
    >
      {code}
    </span>
  );
}
