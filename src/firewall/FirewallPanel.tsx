// 🧯 The rhetoric firewall panel (in AI chat): paste a link or words, or listen live, and see the
// argument with the delivery stripped off.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JournalStore } from "../store";
import { formatDuration } from "../lib/capture";
import { FALLACIES, convictionShift, tally, watchUrl, type CheckRec, type Claim } from "../lib/firewall";
import { youtubeId } from "../lib/linkPreview";
import { showError, showToast } from "../lib/toast";
import { openLink } from "../editor/linkCard";
import {
  FIREWALL_EVENT,
  cancelListening,
  checkSource,
  checkToToday,
  firewallBusy,
  firewallState,
  loadChecks,
  resetFirewall,
  setAfter,
  showCheck,
  showingFirewall,
  sourceOf,
  startListening,
  stopListening,
  subscribeFirewall,
  takeQueued,
} from "./firewall";
import "./firewall.css";

const BASIS = { evidence: "📊 evidence", reasoning: "🧩 reasoning", assertion: "🗣️ just said", emotion: "🔥 feeling" } as const;
const seconds = (t: string) => t.split(":").reduce((s, p) => s * 60 + Number(p), 0);
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** 0–10 as a row of taps (tap the chosen one again to clear it). */
function Conviction({ value, onPick, label }: { value: number | undefined; onPick: (v: number | undefined) => void; label: string }) {
  return (
    <div className="fw-conv" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      <div>
        {Array.from({ length: 11 }, (_, i) => (
          <button key={i} type="button" role="radio" aria-checked={value === i} className={value === i ? "on" : ""} onClick={() => onPick(value === i ? undefined : i)}>
            {i}
          </button>
        ))}
      </div>
    </div>
  );
}

function ClaimCard({ c, video }: { c: Claim; video: string | null }) {
  return (
    <li className={`fw-claim fw-basis-${c.basis}`} style={{ ["--h" as string]: c.heat }}>
      <div className="fw-claim-top">
        <span className="fw-n">{c.n}</span>
        {c.t && (video ? (
          <button type="button" className="fw-t" onClick={() => void openLink(`${watchUrl(video)}&t=${seconds(c.t)}s`)} title="Open the video here">▶ {c.t}</button>
        ) : (
          <span className="fw-t">{c.t}</span>
        ))}
        <span className="fw-basis">{BASIS[c.basis]}</span>
        <span className="fw-heat" title="How much of its pull is emotional">{c.heat}% 🔥</span>
      </div>
      {c.quote && <p className="fw-quote">“{c.quote}”</p>}
      <p className="fw-premise"><span>Stripped</span>{c.premise || c.claim}</p>
      {(c.fallacies.length > 0 || c.contradicts.length > 0) && (
        <div className="fw-badges">
          {c.fallacies.map((f) => (
            <details key={f} className="fw-fallacy">
              <summary>{f}</summary>
              <p>{FALLACIES[f] ?? "A trick the model named; not in the guide."}</p>
            </details>
          ))}
          {c.contradicts.map((x) => (
            <span key={x} className="fw-vs">⚡ clashes with #{x}</span>
          ))}
        </div>
      )}
      {c.incentive && <p className="fw-incentive">💰 {c.incentive}</p>}
      {c.plain && <p className="fw-plain">→ {c.plain}</p>}
    </li>
  );
}

function Result({ r, store, onNew }: { r: CheckRec; store: JournalStore; onNew: () => void }) {
  const t = tally(r);
  const video = r.source.url ? youtubeId(r.source.url) : null;
  const shift = typeof r.before === "number" && typeof r.after === "number" ? r.after - r.before : null;
  return (
    <div className="fw-result">
      <header className="fw-head">
        <div>
          <b>{r.speaker || "Unknown speaker"}</b>
          <span>{r.topic || r.source.title || ""}</span>
        </div>
        {r.source.url && <button type="button" className="fw-src" onClick={() => void openLink(r.source.url!)}>{video ? "▶ Video" : "🔗 Page"}</button>}
      </header>
      <div className="fw-meter" style={{ ["--h" as string]: r.heat }} aria-label={`${100 - r.heat}% logic, ${r.heat}% emotion`}>
        <span className="fw-meter-l">🧠 Logic {100 - r.heat}%</span>
        <span className="fw-meter-bar"><i /></span>
        <span className="fw-meter-r">{r.heat}% Emotion 🔥</span>
      </div>
      {r.verdict && <p className="fw-verdict">{r.verdict}</p>}
      <div className="fw-tally">
        <span>{t.claims} claims</span>
        <span className={t.tricks ? "hot" : ""}>{t.tricks} tricks</span>
        <span className={t.contradictions ? "hot" : ""}>{t.contradictions} contradictions</span>
        <span>{t.bare} with nothing behind them</span>
        {t.top.map(([f, n]) => (
          <span key={f} className="fw-top">{f}{n > 1 ? ` ×${n}` : ""}</span>
        ))}
      </div>
      <ol className="fw-claims">
        {r.claims.map((c) => (
          <ClaimCard key={c.n} c={c} video={video} />
        ))}
      </ol>
      {(r.contradictions.length > 0 || r.past.length > 0) && (
        <section className="fw-box fw-clash">
          <h4>⚡ Can't both be true</h4>
          <ul>
            {r.contradictions.map((p, i) => (
              <li key={i}>
                <b>#{p.a} vs #{p.b}</b> {p.why}
              </li>
            ))}
            {r.past.map((p, i) => (
              <li key={`p${i}`}>
                <b>#{p.n} vs {p.day ? when(p.day) : "before"}</b> “{p.prior}” {p.why}
              </li>
            ))}
          </ul>
        </section>
      )}
      {(r.steelman || r.holds.length > 0) && (
        <section className="fw-box fw-fair">
          <h4>⚖️ Fair to them</h4>
          {r.steelman && <p>{r.steelman}</p>}
          {r.holds.length > 0 && (
            <ul>
              {r.holds.map((h, i) => (
                <li key={i}>✓ {h}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      {r.ask.length > 0 && (
        <section className="fw-box">
          <h4>❓ What would settle it</h4>
          <ul>
            {r.ask.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      )}
      <Conviction label="And now, how convinced are you?" value={r.after} onPick={(v) => v !== undefined && void setAfter(store, r.id, v)} />
      {shift !== null && (
        <p className="fw-shift">
          {shift === 0 ? "Same as before: the delivery wasn't doing the work." : shift < 0 ? `${-shift} point${shift === -1 ? "" : "s"} less convinced once the delivery was stripped.` : `${shift} point${shift === 1 ? "" : "s"} more convinced: the argument held up.`}
        </p>
      )}
      <div className="fw-actions">
        <button
          type="button"
          onClick={async () => {
            try {
              await checkToToday(store, r);
              showToast("Added to today's note");
            } catch (e) {
              showError("Couldn't add it", e);
            }
          }}
        >
          ＋ Today
        </button>
        <button type="button" onClick={onNew}>↺ New check</button>
        <span className="fw-by">{r.by} · {when(r.at)}</span>
      </div>
    </div>
  );
}

/** 🧯 Strip the delivery, see the argument. */
export function FirewallPanel({ store, onClose }: { store: JournalStore; onClose: () => void }) {
  const s = useSyncExternalStore(subscribeFirewall, firewallState);
  const [input, setInput] = useState(() => takeQueued() ?? "");
  const [speaker, setSpeaker] = useState("");
  const [before, setBefore] = useState<number | undefined>();
  const [history, setHistory] = useState<CheckRec[]>([]);
  const words = useRef<HTMLParagraphElement>(null);
  useEffect(showingFirewall, []);
  useEffect(() => {
    const load = () => void loadChecks(store).then(setHistory, () => {});
    load();
    window.addEventListener(FIREWALL_EVENT, load);
    // Another link card's 🧯 while the panel is open.
    const onOpen = (e: Event) => {
      if ((e as CustomEvent).detail !== "firewall") return;
      const q = takeQueued();
      if (q && !firewallBusy()) {
        resetFirewall();
        setInput(q);
      }
    };
    window.addEventListener("journal:open-ai-chat", onOpen);
    return () => {
      window.removeEventListener(FIREWALL_EVENT, load);
      window.removeEventListener("journal:open-ai-chat", onOpen);
    };
  }, [store]);
  useEffect(() => {
    const el = words.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.live?.text]);

  const kind = input.trim() ? sourceOf(input).kind : null;
  const fresh = () => {
    resetFirewall();
    setInput("");
    setBefore(undefined);
  };
  const shift = convictionShift(history);
  const live = s.live;

  return (
    <div className="ai-section fw">
      <div className="ai-chat-bar">
        <strong className="fw-title">🧯 Rhetoric firewall</strong>
        <button type="button" onClick={onClose} aria-label="Close" title={firewallBusy() ? "Keeps going; you'll get a note when it's done" : "Close"}>
          ✕
        </button>
      </div>
      <div className="fw-scroll">
        {(s.phase === "idle" || s.phase === "error") && (
          <form
            className="fw-form"
            onSubmit={(e) => {
              e.preventDefault();
              void checkSource(store, { input, speaker, before });
            }}
          >
            <p className="hint">Strips the confidence, urgency, jargon and flags off what someone says and shows the bare argument: each claim as plain logic, the trick if there is one, contradictions, who gains, and what does hold up.</p>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} placeholder="Paste a YouTube link, any web link, or the words themselves" />
            {kind && <span className="fw-kind">{kind === "youtube" ? "▶ YouTube: Gemini watches the video itself" : kind === "link" ? "🔗 Web page: its text is read" : "📝 Text"}</span>}
            <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="Who's talking? (optional; earlier claims by them are checked too)" list="fw-speakers" />
            <datalist id="fw-speakers">
              {[...new Set(history.map((h) => h.speaker).filter(Boolean))].map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <Conviction label="Before you look: how convinced are you? (optional)" value={before} onPick={setBefore} />
            {s.phase === "error" && <p className="fw-error">{s.error}</p>}
            <div className="fw-actions">
              <button type="submit" className="fw-primary" disabled={!input.trim()}>🧯 Check</button>
              <button type="button" onClick={() => void startListening(store, { speaker, before })} title="The microphone hears a talk, a call or a video playing nearby; every ~40 s is checked">
                🎧 Listen live
              </button>
            </div>
          </form>
        )}

        {(s.phase === "reading" || s.phase === "thinking") && (
          <p className="fw-status"><span className="fw-spin" />{s.step}</p>
        )}

        {(s.phase === "listening" || s.phase === "summing") && live && (
          <div className="fw-live">
            <div className="vg-controls">
              {s.phase === "listening" ? (
                <>
                  <span className="vg-meter" aria-hidden="true">
                    <span style={{ transform: `scaleX(${Math.min(1, live.level * 3).toFixed(3)})` }} />
                  </span>
                  <span className="vg-time">● {formatDuration(live.seconds)}</span>
                  <button type="button" className="vg-stop" onClick={() => void stopListening(store)}>⏹ Stop & sum up</button>
                  <button type="button" onClick={cancelListening} title="Throw it away">🗑</button>
                </>
              ) : (
                <span className="fw-status"><span className="fw-spin" />{s.step}</span>
              )}
            </div>
            <p ref={words} className="fw-words">{live.text || s.step || "Listening…"}</p>
            {live.pending && <p className="hint"><span className="fw-spin" />Checking what was just said…</p>}
            {live.note && <p className="hint">{live.note}</p>}
            {live.claims.length > 0 && (
              <ol className="fw-claims">
                {[...live.claims].reverse().map((c) => (
                  <ClaimCard key={c.n} c={c} video={null} />
                ))}
              </ol>
            )}
          </div>
        )}

        {s.phase === "done" && s.result && <Result r={s.result} store={store} onNew={fresh} />}

        {!firewallBusy() && history.length > 0 && (
          <details className="fw-history">
            <summary>
              Earlier checks ({history.length})
              {shift.n > 0 && <span className="fw-shiftchip">{shift.avg < 0 ? `${shift.avg}` : `+${shift.avg}`} conviction on average</span>}
            </summary>
            <ul>
              {[...history].reverse().map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => showCheck(h)} className={s.result?.id === h.id ? "on" : ""}>
                    <span className="fw-hist-heat" style={{ ["--h" as string]: h.heat }} />
                    <span className="fw-hist-text">
                      <b>{h.speaker || "Unknown"}</b> {h.topic || h.source.title || ""}
                    </span>
                    <span className="fw-hist-day">{when(h.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
