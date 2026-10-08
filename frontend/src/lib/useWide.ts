"use client";

import { useEffect, useState } from "react";

/** True on screens wide enough for the full dashboard. Starts false so phones never load it. */
export function useWide(minWidth = 820): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [minWidth]);
  return wide;
}
