import { JOY_LANE_MAX, JOY_LANE_MIN, joyLane, setJoyLane } from "../nav/joyPrefs";
import { ambienceSettings, setAmbienceSettings, type AmbienceSettings } from "../lib/ambience";
import type { ToneMode } from "../lib/softLight";
import { useEffect, useState } from "react";
import { localModels, testKey } from "../ai/client";
import { DEFAULT_MODELS, PROVIDERS, type Provider } from "../ai/providers";
import { getKey, removeKey, setKey } from "../ai/secrets";
import { loadAiSettings, modelFor, monthUsage, saveAiSettings, type AiSettings } from "../ai/settings";
import { dayTitle } from "../lib/timestamp";
import { KOKORO_EN_VOICES, MODEL_NAMES, onVoiceProgress, readAloud, setVoiceEngine, voiceAction, voiceEngine, voiceInfo, type VoiceInfo, type VoiceProgress } from "../lib/readAloud";
import { downloadParadee, PARADEE_SIZE_MB, paradeeInstalled, removeParadee } from "../lib/paradee";
import { showError, showToast } from "../lib/toast";
import type { AiChange, JournalStore } from "../store";
import { mcpAvailable, mcpEnabled, setMcpServer } from "../mcp";
import { isDesktopApp, macBubbleEnabled, setMacBubble } from "../bubble/macBubble";
import { editorPrefs, setEditorPrefs, type EditorPrefs } from "../lib/editorPrefs";
import { THEMES, currentTheme, setTheme } from "../lib/theme";
import { CANVAS_ACTIONS, loadGestures, saveGestures, type CanvasAction, type Gestures } from "../lib/gestures";

const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** The key for one provider: saved on this device only, testable, removable. */
function KeyField({ provider }: { provider: Provider }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; message?: string }>({ state: "idle" });
  const help = PROVIDERS.find((p) => p.id === provider)!.keyHelp;

  useEffect(() => {
    setDraft("");
    setTest({ state: "idle" });
    getKey(provider).then((k) => setSaved(!!k)).catch(() => setSaved(false));
  }, [provider]);

  const save = async () => {
    try {
      await setKey(provider, draft);
      setDraft("");
      setSaved(true);
      showToast("Key saved on this device");
    } catch (e) {
      showError("Couldn't save the key", e);
    }
  };
  const runTest = async () => {
    const key = draft.trim() || (await getKey(provider));
    if (!key) return setTest({ state: "error", message: "Paste a key first." });
    setTest({ state: "testing" });
    try {
      const model = await testKey(provider, key);
      setTest({ state: "ok", message: `Works (${model})` });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const message = (e instanceof Error && e.name === "TimeoutError") || /cancel|abort|timed? ?out/i.test(raw) ? "No answer from the AI service in time (it may be busy; try again in a minute)." : raw;
      setTest({ state: "error", message });
    }
  };

  return (
    <div className="settings-key">
      <label className="settings-label" htmlFor={`key-${provider}`}>
        API key {saved ? <span className="settings-ok">✓ saved on this device</span> : saved === false ? <span className="hint">not set</span> : null}
      </label>
      <div className="settings-row">
        <input
          id={`key-${provider}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={saved ? "•••••••• (paste a new key to replace)" : "Paste your key"}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" onClick={save} disabled={!draft.trim()}>Save</button>
      </div>
      <div className="settings-row">
        <button type="button" onClick={runTest} disabled={test.state === "testing"}>{test.state === "testing" ? "Testing…" : "Test key"}</button>
        {saved && (
          <button
            type="button"
            onClick={async () => {
              await removeKey(provider);
              setSaved(false);
            }}
          >
            Remove key
          </button>
        )}
        {test.state === "ok" && <span className="settings-ok">✓ {test.message}</span>}
        {test.state === "error" && <span className="settings-error">{test.message}</span>}
      </div>
      <p className="hint">{help} Stored only on this device (never synced or backed up).</p>
    </div>
  );
}

/** Mac: the local model (Ollama): which one, and a test. */
function LocalModelField({ model, onModel, heavy, onHeavy }: { model: string; onModel: (m: string) => void; heavy: string; onHeavy: (m: string) => void }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; message?: string }>({ state: "idle" });
  useEffect(() => {
    void localModels().then(setModels);
  }, []);
  // Ollama lists "llama3.2:latest" for "llama3.2": show them as one.
  const shown = (m: string) => (models?.includes(`${m}:latest`) ? `${m}:latest` : m);
  const options = (m: string) => [...new Set([shown(m), ...(models ?? [])])];
  const run = async () => {
    setTest({ state: "testing" });
    const started = performance.now();
    try {
      await testKey("local", "");
      setTest({ state: "ok", message: `Works (${model}, ${((performance.now() - started) / 1000).toFixed(1)} s)` });
    } catch (e) {
      setTest({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="settings-key">
      <label className="settings-label" htmlFor="local-model">Quick tasks (grammar fixes)</label>
      <div className="settings-row">
        <select id="local-model" value={shown(model)} onChange={(e) => onModel(e.target.value)}>
          {options(model).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button type="button" onClick={() => void run()} disabled={test.state === "testing"}>{test.state === "testing" ? "Testing…" : "Test"}</button>
      </div>
      <label className="settings-label" htmlFor="local-heavy">Heavy reasoning (Organise, prompt refine, chat, photos)</label>
      <div className="settings-row">
        <select id="local-heavy" value={shown(heavy)} onChange={(e) => onHeavy(e.target.value)}>
          {options(heavy).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {test.state === "ok" && <span className="settings-ok">✓ {test.message}</span>}
      {test.state === "error" && <span className="settings-error">{test.message}</span>}
      <p className="hint">
        {models && !models.length ? "Ollama isn't running (or has no models). " : ""}Runs on this Mac; nothing leaves it. When it isn't running, Gemini is used instead (if it has a key).
      </p>
    </div>
  );
}

/** "AI changes": every edit an AI made, with Undo while nothing has changed the note since. */
function AiChanges({ store }: { store: JournalStore }) {
  const [changes, setChanges] = useState<AiChange[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    store.aiChanges(30).then(setChanges);
  }, [store, tick]);
  if (!changes) return null;
  if (!changes.length) return <p className="hint">No AI edits yet.</p>;
  return (
    <ul className="ai-changes">
      {changes.map((c) => (
        <li key={c.event.id}>
          <span className="ai-change-where">
            {c.event.actor} · {c.day ? dayTitle(c.day).replace(/^\w+, /, "") : `📄 ${c.title}`} · {new Date(c.event.createdAt).toLocaleString()}
          </span>
          <button
            type="button"
            disabled={!c.undoable}
            title={c.undoable ? "Put the note back as it was before this edit" : "The note changed after this edit"}
            onClick={async () => {
              if (await store.undoAiChange(c.event.id)) {
                showToast("AI edit undone");
                window.dispatchEvent(new Event("journal:reload-page"));
              }
              setTick((n) => n + 1);
            }}
          >
            {c.undoable ? "Undo" : "Changed after"}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Paradee: a 9 MB English voice that runs in the app itself (lib/paradee.ts), same on Mac and phone. */
function ParadeeSettings() {
  const [engine, setEngine] = useState(voiceEngine);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [got, setGot] = useState<number | null>(null);
  useEffect(() => void paradeeInstalled().then(setInstalled), []);
  const choose = (e: "paradee" | "kokoro") => (setVoiceEngine(e), setEngine(e));
  const download = async () => {
    setGot(0);
    try {
      await downloadParadee((r) => setGot(r));
      setInstalled(true);
      choose("paradee");
    } catch (e) {
      showError("Paradee download failed", e);
    } finally {
      setGot(null);
    }
  };
  return (
    <>
      <div className="settings-label">Engine</div>
      <div className="project-status" role="radiogroup" aria-label="Voice engine">
        <button type="button" role="radio" aria-checked={engine === "paradee"} className={engine === "paradee" ? "active status-active" : ""} onClick={() => choose("paradee")}>Paradee (tiny, fast)</button>
        <button type="button" role="radio" aria-checked={engine === "kokoro"} className={engine === "kokoro" ? "active status-active" : ""} onClick={() => choose("kokoro")}>Kokoro / device voice</button>
      </div>
      {engine === "paradee" && (
        <div className="settings-row">
          {installed ? (
            <>
              <button type="button" onClick={() => readAloud("Hi Hapi. This is how your journal sounds when Paradee reads it aloud.")}>▶ Try</button>
              <button type="button" onClick={() => void removeParadee().then(() => setInstalled(false))}>Remove ({PARADEE_SIZE_MB} MB)</button>
            </>
          ) : (
            <button type="button" disabled={got !== null} onClick={() => void download()}>
              {got !== null ? `Downloading… ${(got / 1_000_000).toFixed(1)} MB` : `Download Paradee (~${PARADEE_SIZE_MB} MB)`}
            </button>
          )}
        </div>
      )}
      {engine === "paradee" && <p className="hint">One English voice (Paradee 8M by Sahil Mahendrakar, Apache 2.0), runs on this device. Until it's downloaded, the voice below is used.</p>}
    </>
  );
}

/** Read aloud: download Kokoro once, pick the model and voice. Without it the system voice is used. */
function ReadAloudSettings() {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [progress, setProgress] = useState<VoiceProgress | null>(null);
  const refresh = () => void voiceInfo().then(setInfo);
  useEffect(() => {
    refresh();
    return onVoiceProgress((p) => {
      setProgress(p);
      if (p.state !== "downloading") refresh();
      if (p.state === "error") showError("Voice download failed", p.message);
    });
  }, []);
  if (!info) return <><ParadeeSettings /><p className="hint">Otherwise this device's voice (the best Premium/Enhanced one installed).</p></>;
  const act = (action: Parameters<typeof voiceAction>[0], value: string | number) => void voiceAction(action, value).then(refresh);
  const current = info.models.find((m) => m.id === info.model);
  const voices = info.model.includes("-en-") ? KOKORO_EN_VOICES : Array.from({ length: Math.max(info.speakers, 1) }, (_, i) => `Voice ${i + 1}`);
  const mb = (n: number) => Math.round(n / 1048576);
  return (
    <>
      <ParadeeSettings />
      <div className="settings-label">Voice model</div>
      <div className="project-status" role="radiogroup" aria-label="Voice model">
        {info.models.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={info.model === m.id} className={info.model === m.id ? "active status-active" : ""}
            onClick={() => act("model", m.id)}>
            {MODEL_NAMES[m.id] ?? m.id}
          </button>
        ))}
      </div>
      {current && !current.installed && (
        <div className="settings-row">
          <button type="button" disabled={!!info.downloading} onClick={() => act("download", current.id)}>
            {info.downloading === current.id ? "Downloading…" : `Download voice (~${current.sizeMb} MB)`}
          </button>
          {progress?.state === "downloading" && progress.model === current.id && (
            <span className="hint">{mb(progress.received)}{progress.total > 0 ? ` / ${mb(progress.total)}` : ""} MB</span>
          )}
        </div>
      )}
      {current?.installed && (
        <>
          <label className="settings-label" htmlFor="kokoro-voice">Voice</label>
          <div className="settings-row">
            <select id="kokoro-voice" value={info.voice} onChange={(e) => act("voice", Number(e.target.value))}>
              {voices.map((v, i) => <option key={i} value={i}>{v}</option>)}
            </select>
            <button type="button" onClick={() => readAloud("Hi Hapi. This is how your journal sounds when I read it aloud.")}>▶ Try</button>
            <button type="button" onClick={() => act("remove", current.id)}>Remove ({current.sizeMb} MB)</button>
          </div>
        </>
      )}
      <p className="hint">
        {current?.installed ? "Kokoro runs on this device, no internet needed." : "Until it's downloaded, this device's own voice is used."} Kept on this device only (never synced or backed up).
      </p>
    </>
  );
}

/** Mac: the journal as an MCP server, so Claude Desktop can read it and add to it. */
function McpSettings({ store }: { store: JournalStore | null }) {
  const [on, setOn] = useState(mcpEnabled);
  if (!mcpAvailable() || !store) return null;
  const config = JSON.stringify({ mcpServers: { journal: { command: "npx", args: ["-y", "mcp-remote", "http://127.0.0.1:39477/mcp"] } } }, null, 2);
  return (
    <section className="settings-section">
      <h2>MCP server (Claude Desktop)</h2>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={on}
          onChange={async (e) => {
            const next = e.target.checked;
            try {
              await setMcpServer(store, next);
              setOn(next);
            } catch (err) {
              showError("Couldn't start the MCP server", err);
            }
          }}
        />
        Let Claude Desktop read and add to this journal
      </label>
      <p className="hint">
        Only this Mac can connect (127.0.0.1:39477), and only while the app is open. Tools: today, read a day or page, search,
        list days, and append. Anything it adds is saved under its name and listed in AI changes below, with Undo.
      </p>
      {on && (
        <>
          <div className="settings-label">Add this to Claude Desktop → Settings → Developer → Edit Config, then restart Claude:</div>
          <pre className="settings-code">{config}</pre>
        </>
      )}
    </section>
  );
}

/** Phone swipes across the note (the week strip's are fixed: right = menu, left = year). */
function GestureSettings() {
  const [g, setG] = useState(loadGestures);
  const [lane, setLane] = useState(joyLane);
  if (!window.matchMedia?.("(pointer: coarse)").matches) return null;
  const set = (k: keyof Gestures, v: CanvasAction) => {
    const next = { ...g, [k]: v };
    setG(next);
    saveGestures(next);
  };
  return (
    <section className="settings-section">
      <h2>Gestures</h2>
      {(["right", "left"] as const).map((k) => (
        <label key={k} className="settings-row">
          <span>Swipe {k === "right" ? "left → right" : "right → left"} on the note</span>
          <select value={g[k]} onChange={(e) => set(k, e.target.value as CanvasAction)}>
            {CANVAS_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
      ))}
      <p className="hint">On the week strip: left → right opens the menu, right → left opens the year.</p>
      <label className="settings-number">
        <span>Home button: sideways sensitivity</span>
        <span className="settings-slider">
          <input
            type="range"
            min={JOY_LANE_MIN}
            max={JOY_LANE_MAX}
            step={5}
            // Right = more sensitive (a narrower lane).
            value={JOY_LANE_MIN + JOY_LANE_MAX - lane}
            onChange={(ev) => {
              const v = JOY_LANE_MIN + JOY_LANE_MAX - Number(ev.target.value);
              setLane(v);
              setJoyLane(v);
            }}
            aria-label="Home button sideways sensitivity"
          />
          <output>{Math.round(((JOY_LANE_MAX - lane) / (JOY_LANE_MAX - JOY_LANE_MIN)) * 100)}%</output>
        </span>
        <small>Hold Home and drag: inside the faint lines it only scrolls up and down; crossing a line changes the day. Lower = wider lane, harder to change day by accident.</small>
      </label>
    </section>
  );
}

/** Code blocks, stamps on older days, the time-ago line. */
function EditorSettings() {
  const [e, setE] = useState(editorPrefs);
  const row = (key: { [K in keyof EditorPrefs]: EditorPrefs[K] extends boolean ? K : never }[keyof EditorPrefs], label: string, hint: string) => (
    <label className="settings-toggle">
      <input type="checkbox" checked={e[key]} onChange={(ev) => setE(setEditorPrefs({ [key]: ev.target.checked }))} />
      <span className="settings-toggle-text">
        {label}
        <small>{hint}</small>
      </span>
    </label>
  );
  return (
    <section className="settings-section">
      <h2>Editor</h2>
      {row("codeScroll", "Scroll code blocks sideways", "Off: long code lines wrap onto the next line instead")}
      {row("editStamps", "Stamp edits on older days", "Writing in a past day adds a small “edited” chip with when")}
      {row("relativeTime", "Show how long ago a day is", "Under the date: years, months and days from today")}
      {row("timeFlash", "Flash the line you jump to", "Tapping a dot on the time rail lights that line for 4 s in its time of day's colour")}
      {row("autoMath", "Solve math as you type", "Type = after a sum and the answer appears: 12+12= becomes 12+12=24 (undo takes it back)")}
      {row("prettyMath", "Draw formulas", "Plain maths like (a+b+c+d)/2 or x^2 shows as a proper formula; the line you're writing in stays plain text")}
      {row("typingGuide", "Typing speed guide", "Typing faster than the limit turns the cursor red and hot and buzzes the phone, as a reminder to slow down")}
      {e.typingGuide && (
        <label className="settings-number">
          <span>Most characters per second</span>
          <span className="settings-slider">
            <input
              type="range"
              min={1}
              max={15}
              step={0.5}
              value={e.maxCps}
              onChange={(ev) => setE(setEditorPrefs({ maxCps: Math.min(15, Math.max(1, Number(ev.target.value))) }))}
              aria-label="Most characters per second"
            />
            <output>{e.maxCps}</output>
          </span>
          <small>About {Math.round(e.maxCps * 12)} words a minute. 5 is calm handwriting pace, 8 is quick typing.</small>
        </label>
      )}
      <div className="settings-label">⏳ Deadlines today in the month view</div>
      <div className="project-status" role="radiogroup" aria-label="Deadlines today in the month view">
        {([["below", "Under Coming up"], ["left", "Left of Coming up"], ["off", "Don't show"]] as const).map(([v, t]) => (
          <button key={v} type="button" role="radio" aria-checked={e.monthDeadlines === v} className={e.monthDeadlines === v ? "active status-active" : ""} onClick={() => setE(setEditorPrefs({ monthDeadlines: v }))}>
            {t}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Theme picker, like Obsidian's: a card per theme with a small preview. Kept on this device. */
function ThemeSection() {
  const [theme, setT] = useState(currentTheme);
  return (
    <section className="settings-section">
      <h2>Theme</h2>
      <div className="theme-picker" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className="theme-card" onClick={() => setT(setTheme(t.id))}>
            <span className={`theme-preview ${t.id}`} aria-hidden="true">
              <i className="tp-card" />
              <i className="tp-button" />
              <i className="tp-well" />
            </span>
            <span className="theme-card-name">
              {t.name}
              {theme === t.id && <span className="theme-check">✓</span>}
            </span>
            <span className="theme-card-hint">{t.hint}</span>
          </button>
        ))}
      </div>
      <p className="hint">Soft UI with “Shadows follow the sun” on: the surface moves by itself from a soft daytime tone, dimmer and warmer as the sun gets low, to dark after sunset. Otherwise light or dark follows the system setting.</p>
    </section>
  );
}

const TONE_MODES: { id: ToneMode; name: string; hint: string }[] = [
  { id: "both", name: "Both dynamic", hint: "Light by day, dark after sunset, gliding between them." },
  { id: "light", name: "Light dynamic", hint: "Light all day and night; the shadows and light colour still follow the sun." },
  { id: "dark", name: "Dark dynamic", hint: "Dark all day with deeper shadows; the shadows and light colour still follow the sun." },
];

/** Optional light, weather and sound on the glass. */
function AmbienceSection() {
  const [a, setA] = useState(ambienceSettings);
  const [theme, setThemeState] = useState(currentTheme);
  useEffect(() => {
    const on = () => setThemeState(currentTheme());
    window.addEventListener("journal:theme", on);
    return () => window.removeEventListener("journal:theme", on);
  }, []);
  const row = (key: Exclude<keyof AmbienceSettings, "tone">, label: string) => (
    <label className="settings-toggle">
      <input type="checkbox" checked={a[key]} onChange={(e) => setA(setAmbienceSettings({ [key]: e.target.checked }))} />
      {label}
    </label>
  );
  return (
    <section className="settings-section">
      <h2>Look and feel</h2>
      {theme === "neu" ? (
        <>
          {row("daylight", "Shadows follow the sun (direction, length and colour of the light)")}
          {a.daylight && (
            <>
              <div className="settings-label">Light and dark</div>
              <div className="project-status" role="radiogroup" aria-label="Light and dark">
                {TONE_MODES.map((m) => (
                  <button key={m.id} type="button" role="radio" aria-checked={a.tone === m.id} className={a.tone === m.id ? "active status-active" : ""} onClick={() => setA(setAmbienceSettings({ tone: m.id }))}>
                    {m.name}
                  </button>
                ))}
              </div>
              <p className="hint">{TONE_MODES.find((m) => m.id === a.tone)?.hint}</p>
            </>
          )}
          {row("weather", "Weather on the surface (soft light when cloudy, raised drops when it rains)")}
          {row("sounds", "Soft press sounds and haptics when touching and swiping")}
        </>
      ) : (
        <>
          {row("daylight", "Brightness follows the time of day")}
          {row("weather", "Weather on the glass (sun rays, clouds, rain drops)")}
          {row("sounds", "Glass sounds and haptics when touching and swiping")}
        </>
      )}
      <p className="hint">Weather uses Open-Meteo for this device’s rough location (asked once, then remembered for 6 hours), checked every 30 minutes.</p>
    </section>
  );
}

/** Mac: the floating bubble window. */
function MacBubbleSettings() {
  const [on, setOn] = useState(macBubbleEnabled);
  return (
    <section className="settings-section">
      <h2>Floating bubble</h2>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={on}
          onChange={async (e) => {
            const next = e.target.checked;
            try {
              await setMacBubble(next);
              setOn(next);
            } catch (err) {
              showError("Couldn't change the bubble", err);
            }
          }}
        />
        Show floating bubble
      </label>
      <p className="hint">A small drop that stays on top of every app and Space. Click it, or press ⌘⇧J anywhere, to write a quick note or save what's on the clipboard (YouTube links with a preview) to today. Drag it anywhere.</p>
    </section>
  );
}

/** Android: the floating bubble over other apps. */
function BubbleSettings() {
  const bubble = window.JournalBubble;
  const [on, setOn] = useState(() => bubble?.enabled() ?? false);
  // Coming back from Android's "Display over other apps" screen.
  useEffect(() => {
    const check = () => bubble && setOn(bubble.enabled());
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [bubble]);
  if (!bubble) return isDesktopApp() ? <MacBubbleSettings /> : null;
  return (
    <section className="settings-section">
      <h2>Floating bubble</h2>
      <label className="settings-toggle">
        <input type="checkbox" checked={on} onChange={(e) => setOn(bubble.setEnabled(e.target.checked))} />
        Show floating bubble
      </label>
      <p className="hint">
        A small glass drop that floats over your other apps. Tap it to circle-capture the screen, write a quick note, paste the
        clipboard or record a voice note into today. Drag it anywhere; drop it on ✕ or long-press to hide it.
        {!bubble.canDraw() && " Turning it on opens Android's \"Display over other apps\" setting once: allow Dynamic Journal there, then come back."}
      </p>
    </section>
  );
}

type SettingsPage = "general" | "editor" | "ai" | "voice" | "usage" | "mcp";

function useNarrow() {
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 760px)");
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** ⚙︎ Settings: AI provider, keys, toggles, this month's use, and AI changes. */
export function SettingsPanel({ store, onClose }: { store: JournalStore | null; onClose: () => void }) {
  const [s, setS] = useState<AiSettings>(loadAiSettings);
  const [usage, setUsage] = useState(monthUsage);
  useEffect(() => {
    const onUsage = () => setUsage(monthUsage());
    window.addEventListener("journal:ai-usage", onUsage);
    return () => window.removeEventListener("journal:ai-usage", onUsage);
  }, []);
  const narrow = useNarrow();
  const [page, setPage] = useState<SettingsPage | null>(() => (window.matchMedia?.("(max-width: 760px)").matches ? null : "general"));
  // Going wide (Mac window resized) always shows a category.
  useEffect(() => {
    if (!narrow && !page) setPage("general");
  }, [narrow, page]);
  const update = (patch: Partial<AiSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveAiSettings(next);
  };

  const pages: { id: SettingsPage; icon: string; name: string; hint: string }[] = [
    { id: "general", icon: "✦", name: "Appearance", hint: "Theme, light, weather, sounds, gestures" },
    { id: "editor", icon: "✎", name: "Editor", hint: "Code blocks, quick log, bubble" },
    { id: "ai", icon: "✨", name: "AI", hint: "Provider, models, grammar" },
    { id: "voice", icon: "🔊", name: "Read aloud", hint: "Voice and speed" },
    { id: "usage", icon: "📊", name: "Usage and AI changes", hint: "This month, undo AI edits" },
    ...(mcpAvailable() ? [{ id: "mcp" as const, icon: "⌁", name: "Claude Desktop", hint: "MCP server" }] : []),
  ];
  const current = pages.find((p) => p.id === page);
  const content = (
    <>
      {page === "general" && (
        <>
          <ThemeSection />
          <AmbienceSection />
          <GestureSettings />
        </>
      )}
      {page === "editor" && (
        <>
          <EditorSettings />
          <BubbleSettings />
        </>
      )}
      {page === "ai" && (
          <section className="settings-section">
            <h2>AI</h2>
            <label className="settings-toggle">
              <input type="checkbox" checked={s.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
              AI features on
            </label>
            <div className="settings-label">Provider</div>
            <div className="project-status" role="radiogroup" aria-label="AI provider">
              {PROVIDERS.filter((p) => p.id !== "local" || isDesktopApp()).map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={s.provider === p.id} className={s.provider === p.id ? "active status-active" : ""} onClick={() => update({ provider: p.id })}>
                  {p.name}
                </button>
              ))}
            </div>
            {s.provider === "local" ? (
              <LocalModelField
                model={modelFor(s, "grammar")}
                onModel={(m) => update({ models: { ...s.models, local: { ...s.models.local, grammar: m } } })}
                heavy={modelFor(s, "organise")}
                onHeavy={(m) => update({ models: { ...s.models, local: { ...s.models.local, organise: m, describe: m, chat: m } } })}
              />
            ) : (
              <KeyField provider={s.provider} />
            )}
            {!isDesktopApp() && (
              <label className="settings-toggle">
                <input type="checkbox" checked={s.macGrowsMap !== false} onChange={(e) => update({ macGrowsMap: e.target.checked })} />
                Mac grows the map (its local model does it; the result arrives here by sync)
              </label>
            )}
            <label className="settings-toggle">
              <input type="checkbox" checked={s.grammarSuggestions} onChange={(e) => update({ grammarSuggestions: e.target.checked })} />
              Grammar suggestions after each finished paragraph
            </label>
            <label className="settings-toggle">
              <input type="checkbox" checked={s.mindmapAuto !== false} onChange={(e) => update({ mindmapAuto: e.target.checked })} />
              Grow mind map automatically (from today's note, after 10 quiet minutes)
            </label>
            <label className="settings-toggle">
              <input type="checkbox" checked={s.autoCorrect} onChange={(e) => update({ autoCorrect: e.target.checked })} />
              Auto-correct (apply grammar fixes without asking)
            </label>
            <p className="hint">
              Models: grammar {modelFor(s, "grammar")}, Organise {modelFor(s, "organise")}, photos {modelFor(s, "describe")}
              {modelFor(s, "organise") !== DEFAULT_MODELS[s.provider].organise ? " (custom)" : ""}. AI only runs when you tap or finish a paragraph.
            </p>
          </section>

      )}
      {page === "voice" && (
        <section className="settings-section">
          <h2>Read aloud</h2>
          <ReadAloudSettings />
        </section>
      )}
      {page === "usage" && (
        <>
          <section className="settings-section">
            <h2>This month on this device</h2>
            <p>
              {usage.requests} request{usage.requests === 1 ? "" : "s"} · {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out tokens · about {money(usage.cost)}
            </p>
            <p className="hint">Estimated at paid prices; requests on Google AI Studio's free tier cost nothing.</p>
          </section>
          <section className="settings-section">
            <h2>AI changes</h2>
            {store && <AiChanges store={store} />}
          </section>
        </>
      )}
      {page === "mcp" && <McpSettings store={store} />}
    </>
  );

  // Like Obsidian: categories on the left (Mac) or as a list that opens each one (phone).
  return (
    <div className={page ? "settings-view settings-in-page" : "settings-view"} role="dialog" aria-label="Settings">
      <header className="settings-bar">
        {page && narrow ? (
          <button type="button" className="settings-back" onClick={() => setPage(null)} aria-label="All settings">‹</button>
        ) : (
          <button type="button" className="settings-back" onClick={onClose} aria-label="Close settings">✕</button>
        )}
        <h1 className="settings-title">{page && narrow ? current?.name : "Settings"}</h1>
        {page && narrow && <button type="button" className="settings-done" onClick={onClose}>Done</button>}
      </header>
      <div className="settings-split">
        <nav className="settings-nav" aria-label="Settings categories">
          <div className="settings-nav-group">Options</div>
          {pages.map((p) => (
            <button key={p.id} type="button" className={page === p.id ? "settings-nav-item active" : "settings-nav-item"} onClick={() => setPage(p.id)}>
              <span className="settings-nav-icon" aria-hidden>{p.icon}</span>
              <span className="settings-nav-text">
                <span>{p.name}</span>
                <small>{p.hint}</small>
              </span>
              <span className="settings-nav-chevron" aria-hidden>›</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">{content}</div>
      </div>
    </div>
  );
}
