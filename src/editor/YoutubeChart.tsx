import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { askAi } from "../ai/client";
import { addDays, dayKey } from "../lib/timestamp";
import { showError, showToast } from "../lib/toast";
import { loadYoutubeRange, purposeOf, YT_PURPOSES, youtubeMix, type YoutubeDay } from "../lib/youtubeDigest";
import { STEP_COLORS } from "../routine/charts";
import { useEscapeToClose } from "../ui/useEscapeToClose";

/**
 * 📺 What the watching was (Hapi, 17 Nov): pie charts of the YouTube tracker's days. Useful vs
 * entertainment (the tracker's labels), what kind (topics grouped: learning, entertainment,
 * motivation, news, music, lifestyle), and the domains themselves. A topic the word lists don't
 * know can be sorted by the AI once (kept on this device) or by hand with a tap.
 */

export const YT_CHART_EVENT = "journal:youtube-chart";
const OWN_KEY = "journal.ytPurposes";
type Range = 1 | 7 | 30 | 90;

const readOwn = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(OWN_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const saveOwn = (o: Record<string, string>) => {
  try {
    localStorage.setItem(OWN_KEY, JSON.stringify(o));
  } catch {
    // This session only.
  }
};

const GREY = "#8a8a85";
const PURPOSE_COLORS: Record<string, string> = { learning: STEP_COLORS[2], entertainment: STEP_COLORS[1], motivation: STEP_COLORS[3], news: STEP_COLORS[0], music: STEP_COLORS[4], lifestyle: STEP_COLORS[6], other: STEP_COLORS[7], unsorted: GREY };
const VERDICT_COLORS: Record<string, string> = { useful: STEP_COLORS[2], distraction: STEP_COLORS[1], unlabelled: GREY };

/** A donut with its legend (values and shares); a slice lights up with its legend row. */
function Pie({ title, slices }: { title: string; slices: { id: string; label: string; n: number; color: string }[] }) {
  const [on, setOn] = useState<string | null>(null);
  const total = slices.reduce((a, s) => a + s.n, 0);
  if (!total) return null;
  const R = 52;
  const r = 32;
  let a0 = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const a1 = a0 + (s.n / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${60 + rad * Math.cos(ang)} ${60 + rad * Math.sin(ang)}`;
    const d = slices.length === 1 ? `M 60 ${60 - R} A ${R} ${R} 0 1 1 59.99 ${60 - R} L 59.99 ${60 - r} A ${r} ${r} 0 1 0 60 ${60 - r} Z` : `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
    a0 = a1;
    return { ...s, d };
  });
  const shown = slices.find((s) => s.id === on);
  return (
    <figure className="yt-pie">
      <figcaption>{title}</figcaption>
      <div className="yt-pie-row">
        <svg viewBox="0 0 120 120" role="img" aria-label={`${title}: ${slices.map((s) => `${s.label} ${Math.round((s.n / total) * 100)}%`).join(", ")}`}>
          {arcs.map((s) => (
            <path key={s.id} d={s.d} fill={s.color} opacity={on && on !== s.id ? 0.35 : 1} stroke="var(--bg)" strokeWidth={1.5} onPointerEnter={() => setOn(s.id)} onPointerDown={() => setOn(s.id)} onPointerLeave={() => setOn(null)} />
          ))}
          <text x="60" y="57" textAnchor="middle" className="yt-pie-big">{shown ? `${Math.round((shown.n / total) * 100)}%` : total}</text>
          <text x="60" y="72" textAnchor="middle" className="yt-pie-small">{shown ? shown.n : "videos"}</text>
        </svg>
        <ul>
          {slices.map((s) => (
            <li key={s.id} className={on === s.id ? "on" : ""} onPointerEnter={() => setOn(s.id)} onPointerLeave={() => setOn(null)}>
              <i style={{ background: s.color }} />
              <span>{s.label}</span>
              <b>{Math.round((s.n / total) * 100)}%</b>
              <small>{s.n}</small>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

export function YoutubeCharts({ store, day, initialRange = 7 }: { store: JournalStore; day: string; initialRange?: Range }) {
  const [range, setRange] = useState<Range>(initialRange);
  const [days, setDays] = useState<YoutubeDay[] | null>(null);
  const [own, setOwn] = useState(readOwn);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDays(null);
    void loadYoutubeRange(store, addDays(day, 1 - range), day)
      .then((d) => live && setDays(d))
      .catch(() => live && setDays([]));
    return () => {
      live = false;
    };
  }, [store, day, range]);
  const mix = useMemo(() => youtubeMix(days ?? [], own), [days, own]);
  const unknown = mix.topics.filter((t) => t.purpose === "other").map((t) => t.t);
  const setPurpose = (topic: string, id: string) => {
    const next = { ...own, [topic]: id };
    setOwn(next);
    saveOwn(next);
    setPick(null);
  };
  const sortWithAi = async () => {
    setBusy(true);
    try {
      const ids = YT_PURPOSES.map((p) => p[0]);
      const r = await askAi<{ topics: { topic: string; purpose: string }[] }>({
        task: "grammar",
        cloud: true,
        system: `Group YouTube topics by why someone watches them. Purposes: ${ids.join(", ")}, other. Reply as JSON {"topics":[{"topic","purpose"}]} with every topic given.`,
        text: unknown.join("\n"),
        schema: { type: "object", properties: { topics: { type: "array", items: { type: "object", properties: { topic: { type: "string" }, purpose: { type: "string", enum: [...ids, "other"] } }, required: ["topic", "purpose"] } } }, required: ["topics"] },
        maxTokens: 1500,
      });
      const next = { ...own };
      for (const t of r.json?.topics ?? []) if (t.topic && t.purpose) next[t.topic.toLowerCase().trim()] = t.purpose;
      setOwn(next);
      saveOwn(next);
      showToast("Sorted");
    } catch (e) {
      showError("Couldn't sort them", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="yt-charts">
      <div className="trend-picks" role="radiogroup" aria-label="Days">
        {([1, 7, 30, 90] as Range[]).map((r) => (
          <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>
            {r === 1 ? "This day" : `${r} days`}
          </button>
        ))}
      </div>
      {!days ? (
        <p className="loading">Loading…</p>
      ) : !mix.watches ? (
        <p className="hint">Nothing from the YouTube tracker for these days.</p>
      ) : (
        <>
          <p className="hint">
            {mix.watches} watched{mix.shorts ? `, ${mix.shorts} of them Shorts/reels (${Math.round((mix.shorts / mix.watches) * 100)}%)` : ""}, {days.length} day{days.length === 1 ? "" : "s"}.
          </p>
          <Pie title="Useful or not" slices={mix.verdict.map((v) => ({ ...v, color: VERDICT_COLORS[v.id] ?? GREY }))} />
          <Pie title="What kind" slices={mix.purposes.map((p) => ({ ...p, color: PURPOSE_COLORS[p.id] ?? GREY }))} />
          <Pie
            title="Domains"
            slices={[
              ...mix.topics.slice(0, 7).map((t, i) => ({ id: t.t, label: t.t, n: t.n, color: STEP_COLORS[i] })),
              ...(mix.topics.length > 7 ? [{ id: "rest", label: `${mix.topics.length - 7} more`, n: mix.topics.slice(7).reduce((a, t) => a + t.n, 0), color: GREY }] : []),
            ]}
          />
          <h4 className="yt-topics-h">Topics (tap to change its kind)</h4>
          <ul className="yt-topics">
            {mix.topics.slice(0, 40).map((t) => (
              <li key={t.t}>
                <button type="button" onClick={() => setPick(pick === t.t ? null : t.t)}>
                  <i style={{ background: PURPOSE_COLORS[t.purpose] ?? GREY }} />
                  {t.t} <small>{t.n}</small>
                </button>
                {pick === t.t && (
                  <span className="yt-kinds">
                    {[...YT_PURPOSES.map((p) => [p[0], p[1]] as const), ["other", "❔ Other"] as const].map(([id, label]) => (
                      <button key={id} type="button" className={purposeOf(t.t, own) === id ? "active" : ""} onClick={() => setPurpose(t.t, id)}>{label}</button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {unknown.length > 0 && (
            <button type="button" className="link" disabled={busy} onClick={() => void sortWithAi()}>
              {busy ? "Sorting…" : `✨ Sort the ${unknown.length} “other” topic${unknown.length === 1 ? "" : "s"} with AI`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The charts as a sheet (from the day's 📺 line). */
export function YoutubeChartSheet({ store, day, onClose }: { store: JournalStore; day: string; onClose: () => void }) {
  useEscapeToClose(onClose);
  return createPortal(
    <>
      <div className="search-backdrop" onClick={onClose} />
      <div className="confirm-card yt-sheet" role="dialog" aria-label="What I watched on YouTube">
        <header className="yt-sheet-head">
          <h2>📺 What I watched</h2>
          <button type="button" onClick={() => (onClose(), window.dispatchEvent(new CustomEvent("journal:youtube-history")))} title="Whole history: kinds, channels, ❤ likes">History ›</button>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <YoutubeCharts store={store} day={day} initialRange={day === dayKey(new Date()) ? 7 : 1} />
      </div>
    </>,
    document.body,
  );
}
