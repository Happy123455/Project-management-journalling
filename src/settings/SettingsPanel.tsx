import { useEffect, useState } from "react";
import { testKey } from "../ai/client";
import { DEFAULT_MODELS, PROVIDERS, type Provider } from "../ai/providers";
import { getKey, removeKey, setKey } from "../ai/secrets";
import { loadAiSettings, modelFor, monthUsage, saveAiSettings, type AiSettings } from "../ai/settings";
import { dayTitle } from "../lib/timestamp";
import { showError, showToast } from "../lib/toast";
import type { AiChange, JournalStore } from "../store";

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
      setTest({ state: "error", message: e instanceof Error ? e.message : String(e) });
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
