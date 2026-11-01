import React, { useEffect, useRef, useState } from "react";

/**
 * Text that doesn't fit runs past like a conveyor belt (two copies one after the other, so it
 * loops without a jump); text that fits stays still.
 */
export function Marquee({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const [run, setRun] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    const inner = track.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const one = inner.firstElementChild as HTMLElement | null;
      const w = one?.scrollWidth ?? 0;
      setRun(w > el.clientWidth + 2 ? w : null);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [children]);
  return (
    <span ref={box} className={run ? "marquee ticking" : "marquee"} style={run ? ({ "--marquee-s": `${Math.max(6, run / 28)}s` } as React.CSSProperties) : undefined}>
      <span ref={track} className="marquee-track">
        <span className="marquee-copy">{children}</span>
        {run && <span className="marquee-copy" aria-hidden>{children}</span>}
      </span>
    </span>
  );
}

