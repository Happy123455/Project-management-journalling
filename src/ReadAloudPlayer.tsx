import { useEffect, useState } from "react";
import { pauseReading, RATES, resumeReading, setReadRate, stopReading, subscribeReadAloud, type ReadState } from "./lib/readAloud";

/** The floating player while something is being read aloud: pause/resume, stop, speed. */
export function ReadAloudPlayer() {
  const [s, setS] = useState<ReadState | null>(null);
  useEffect(() => subscribeReadAloud(setS), []);
  if (!s || s.status === "idle") return null;
  const nextRate = RATES[(RATES.indexOf(s.rate) + 1) % RATES.length];
  return (
    <div className="read-aloud" role="region" aria-label="Read aloud" onPointerDown={(e) => e.preventDefault()}>
      <span aria-hidden>🔊</span>
      {s.status === "playing" ? (
        <button type="button" onClick={pauseReading} aria-label="Pause">⏸</button>
      ) : (
        <button type="button" onClick={resumeReading} aria-label="Resume">▶</button>
      )}
      <button type="button" onClick={stopReading} aria-label="Stop">⏹</button>
      <button type="button" className="read-rate" onClick={() => setReadRate(nextRate)} aria-label={`Speed ${s.rate}×, tap for ${nextRate}×`}>
        {s.rate}×
      </button>
    </div>
  );
}
