import { useEffect, useState } from "react";
import { testKey } from "../ai/client";
import { DEFAULT_MODELS, PROVIDERS, type Provider } from "../ai/providers";
import { getKey, removeKey, setKey } from "../ai/secrets";
import { loadAiSettings, modelFor, monthUsage, saveAiSettings, type AiSettings } from "../ai/settings";
import { dayTitle } from "../lib/timestamp";
import { KOKORO_EN_VOICES, MODEL_NAMES, onVoiceProgress, readAloud, voiceAction, voiceInfo, type VoiceInfo, type VoiceProgress } from "../lib/readAloud";
import { showError, showToast } from "../lib/toast";
import type { AiChange, JournalStore } from "../store";
import { mcpAvailable, mcpEnabled, setMcpServer } from "../mcp";
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
      const message = e instanceof Error ? (e.name === "TimeoutError" ? "No answer from the AI service (check the internet connection)." : e.message) : String(e);
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
  if (!info) return <p className="hint">Uses this device's voice (the best Premium/Enhanced one installed).</p>;
  const act = (action: Parameters<typeof voiceAction>[0], value: string | number) => void voiceAction(action, value).then(refresh);
  const current = info.models.find((m) => m.id === info.model);
  const voices = info.model.includes("-en-") ? KOKORO_EN_VOICES : Array.from({ length: Math.max(info.speakers, 1) }, (_, i) => `Voice ${i + 1}`);
  const mb = (n: number) => Math.round(n / 1048576);
  return (
    <>
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
  if (!bubble) return null;
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

/** ⚙︎ Settings: AI provider, keys, toggles, this month's use, and AI changes. */
export function SettingsPanel({ store, onClose }: { store: JournalStore | null; onClose: () => void }) {
  const [s, setS] = useState<AiSettings>(loadAiSettings);
  const [usage, setUsage] = useState(monthUsage);
  useEffect(() => {
    const onUsage = () => setUsage(monthUsage());
    window.addEventListener("journal:ai-usage", onUsage);
    return () => window.removeEventListener("journal:ai-usage", onUsage);
  }, []);
  const update = (patch: Partial<AiSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveAiSettings(next);
  };

  return (
    <div className="settings-view" role="dialog" aria-label="Settings">
      <header className="graph-bar">
        <button type="button" onClick={onClose} aria-label="Close settings">✕</button>
        <h1 className="settings-title">⚙︎ Settings</h1>
      </header>
      <div className="settings-body">
        <section className="settings-section">
          <h2>AI</h2>
          <label className="settings-toggle">
            <input type="checkbox" checked={s.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
            AI features on
          </label>
          <div className="settings-label">Provider</div>
          <div className="project-status" role="radiogroup" aria-label="AI provider">
            {PROVIDERS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={s.provider === p.id} className={s.provider === p.id ? "active status-active" : ""} onClick={() => update({ provider: p.id })}>
                {p.name}
              </button>
            ))}
          </div>
          <KeyField provider={s.provider} />
          <label className="settings-toggle">
            <input type="checkbox" checked={s.grammarSuggestions} onChange={(e) => update({ grammarSuggestions: e.target.checked })} />
            Grammar suggestions after each finished paragraph
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

        <GestureSettings />
        <BubbleSettings />
        <McpSettings store={store} />

        <section className="settings-section">
          <h2>Read aloud</h2>
          <ReadAloudSettings />
        </section>

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
      </div>
    </div>
  );
}
