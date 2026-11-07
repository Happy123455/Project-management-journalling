import { useEffect, useRef, useState } from "react";
import { sendDrop, copyClip } from "./clipboard";
import { addDrop, DROP_EVENT, dropData, listDrops, MAX_DROP, removeDrop, saveToDownloads, type DropItem } from "./drop";
import { bytes } from "./transferLog";
import { showToast } from "../lib/toast";

const onPhone = () => /Android/i.test(navigator.userAgent);

function readBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/**
 * Nexus › Send: type or paste text, pick or drop files, and they go straight to the other device
 * over Wi-Fi. Below, what went across both ways, to copy, save again or put into today's note.
 */
export function DropPanel({ linked, onConnect, onAddToToday }: {
  linked: boolean;
  onConnect?: () => void;
  onAddToToday: (item: DropItem, data: string | null) => Promise<void>;
}) {
  const other = onPhone() ? "Mac" : "phone";
  const [text, setText] = useState("");
  const [items, setItems] = useState<DropItem[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = () => void listDrops().then(setItems);
    on();
    window.addEventListener(DROP_EVENT, on);
    return () => window.removeEventListener(DROP_EVENT, on);
  }, []);

  const sendText = async () => {
    const t = text.trim() ? text : "";
    if (!t) return;
    const c = sendDrop({ text: t });
    if (!c) return void showToast(`Not connected to your ${other}: tap ⚡ Connect first`, "error");
    await addDrop({ id: c.id, at: c.at, mine: true, text: t, size: t.length });
    setText("");
    showToast(`📤 Sent to your ${other}`);
  };

  const sendFiles = async (files: File[]) => {
    if (!files.length) return;
    if (!linked) return void showToast(`Not connected to your ${other}: tap ⚡ Connect first`, "error");
    setBusy(true);
    try {
      for (const f of files) {
        if (f.size > MAX_DROP) {
          showToast(`${f.name} is over ${bytes(MAX_DROP)}: too big to send over the link`, "error");
          continue;
        }
        const data = await readBase64(f);
        const c = sendDrop({ name: f.name, mime: f.type, data });
        if (!c) break;
        await addDrop({ id: c.id, at: c.at, mine: true, name: f.name, mime: f.type, size: f.size }, data);
      }
      showToast(`📤 ${files.length === 1 ? files[0].name : `${files.length} files`} sent to your ${other}`);
    } catch (e) {
      showToast(`Couldn't send: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (it: DropItem) => {
    if (it.text != null) return copyClip({ id: it.id, from: "", at: it.at, text: it.text });
    const data = await dropData(it.id);
    if (data && it.mime?.startsWith("image/")) return copyClip({ id: it.id, from: "", at: it.at, mime: it.mime, data });
  };
  const save = async (it: DropItem) => {
    const data = await dropData(it.id);
    if (!data) return void showToast("That file is no longer kept here", "error");
    const to = await saveToDownloads(it.name ?? "file", it.mime ?? "", data);
    showToast(to ? `Saved to ${to}` : "Couldn't save it", to ? undefined : "error");
  };

  return (
    <div
      className={`drop-panel${over ? " over" : ""}`}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void sendFiles([...e.dataTransfer.files]);
      }}
    >
      {!linked && (
        <p className="hint">
          Sending goes straight over your Wi-Fi while both apps are open.{" "}
          {onConnect && <button type="button" onClick={onConnect}>⚡ Connect to {other}</button>}
        </p>
      )}
      <textarea
        className="drop-text"
        value={text}
        placeholder={`Text or a link for your ${other}…`}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendText();
        }}
      />
      <div className="drop-actions">
        <button type="button" onClick={() => void sendText()} disabled={!text.trim()}>📤 Send text</button>
        <button type="button" onClick={() => pick.current?.click()} disabled={busy}>{busy ? "Sending…" : "📎 Send photos or files"}</button>
        <input ref={pick} type="file" multiple hidden onChange={(e) => (void sendFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
      </div>
      {!onPhone() && <p className="hint drop-hint">Or drop files anywhere here.</p>}
      <ul className="drop-list">
        {items.map((it) => (
          <li key={it.id} className={it.mine ? "mine" : "theirs"}>
            <span className="drop-dir">{it.mine ? "📤" : "📥"}</span>
            <span className="drop-what">
              {it.text != null ? it.text.slice(0, 200) : it.name}
              <small>
                {" "}· {new Date(it.at).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
                {it.text == null ? ` · ${bytes(it.size)}` : ""}
                {it.savedTo ? ` · ${it.savedTo}` : ""}
              </small>
            </span>
            <span className="drop-buttons">
              {(it.text != null || it.mime?.startsWith("image/")) && <button type="button" onClick={() => void copy(it)} title="Copy">📋</button>}
              {it.text == null && !it.mine && <button type="button" onClick={() => void save(it)} title="Save to Downloads">⬇︎</button>}
              <button type="button" onClick={async () => onAddToToday(it, it.text == null ? await dropData(it.id) : null)} title="Put into today's note">＋</button>
              <button type="button" onClick={() => void removeDrop(it.id)} title="Remove from this list">✕</button>
            </span>
          </li>
        ))}
        {!items.length && <li className="hint">Nothing sent or received yet.</li>}
      </ul>
    </div>
  );
}

