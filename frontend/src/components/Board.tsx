"use client";

/** Split-flap departure board. Each changed character flips in, staggered left to right. */
export function Board({
  text,
  length,
  size = "md",
  label,
}: {
  text: string;
  length?: number;
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const n = length ?? text.length;
  const chars = text.toUpperCase().slice(0, n).padEnd(n, " ").split("");
  const cls = size === "lg" ? "flap flap-lg" : size === "sm" ? "flap flap-sm" : "flap";
  return (
    <span className="flaps" role="img" aria-label={label ?? text}>
      {chars.map((ch, i) => (
        <span
          key={`${i}-${ch}`}
          aria-hidden="true"
          className={`${cls} flap-anim`}
          style={{ animationDelay: `${i * 28}ms` }}
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}
