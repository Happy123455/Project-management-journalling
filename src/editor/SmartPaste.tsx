import { YoutubeCard } from "./linkCard";
import { youtubeId } from "../lib/linkPreview";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { coalesce } from "../lib/coalesce";
import type { Editor, JSONContent } from "@tiptap/react";
import { sha256 } from "../lib/files";
import { classifyClip, clipKey, clipPreview, type Clip } from "../lib/smartPaste";
import { hasEmbeds } from "../lib/embeds";
import { insertFiles, pasteEmbeds } from "./attachments";

const HANDLED_KEY = "dynamic-journal.clipboard-handled";
const RETRY_MS = 300;
const MAX_RETRIES = 3;
const MAX_HANDLED = 50;

/**
 * Clipboard text from the app (Tauri plugin) or the browser: "" when empty, null when it
 * couldn't be read (Android refuses until the window has focus).
 */
async function readClipboard(): Promise<string | null> {
  try {
    const native = window.JournalClipboard?.text?.();
    if (native) {
      const { focused, text } = JSON.parse(native) as { focused: boolean; text: string | null };
      return focused ? (text ?? "") : null;
    }
    if ("__TAURI_INTERNALS__" in window) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return (await readText()) ?? "";
    }
    return await navigator.clipboard.readText();
  } catch (e) {
    // The Tauri plugin reports an empty clipboard as an error; anything else is a failed read.
    return /empty|no text|not available/i.test(String(e)) ? "" : null;
  }
}

/** The Android app's bridge to clipboard media with the original bytes (MainActivity.kt). */
declare global {
  interface Window {
    JournalClipboard?: { media(): string; text?(): string };
    __journalClipboardChanged?: () => void;
  }
}

/** An image (or video) on the clipboard, or null. GIFs keep their animation on Android. */
async function readClipboardImage(): Promise<File | null> {
  try {
    const native = window.JournalClipboard?.media();
    if (native) {
      const { mime, data } = JSON.parse(native) as { mime: string; data: string };
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      return new File([bytes], `pasted.${mime.split("/")[1] ?? "bin"}`, { type: mime });
    }
    if ("__TAURI_INTERNALS__" in window) {
      const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const image = await readImage();
      const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      return blob ? new File([blob], "pasted-image.png", { type: "image/png" }) : null;
    }
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return new File([await item.getType(type)], `pasted-image.${type.split("/")[1]}`, { type });
    }
  } catch {
    // No image, or no permission to read it.
  }
  return null;
}

/** Clipboard items already pasted or dismissed, so they aren't suggested again. */
function handledKeys(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HANDLED_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function markHandled(key: string) {
  try {
    const keys = [key, ...handledKeys().filter((k) => k !== key)].slice(0, MAX_HANDLED);
    localStorage.setItem(HANDLED_KEY, JSON.stringify(keys));
  } catch {
    // Without storage the chip may come back for this item; nothing is lost.
  }
}

const paragraphs = (text: string): JSONContent[] =>
  text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));

function insertClip(editor: Editor, clip: Clip, asCode: boolean) {
  const chain = editor.chain().focus();
  if (asCode) {
    const text = clip.kind === "url" ? clip.url : clip.text;
    return chain.insertContent({ type: "codeBlock", content: [{ type: "text", text }] }).run();
  }
  if (clip.kind === "url") return chain.insertContent({ type: "linkCard", attrs: { url: clip.url } }).run();
  if (hasEmbeds(clip.text)) return void pasteEmbeds(editor, clip.text);
  return chain.insertContent(clip.lines > 1 ? paragraphs(clip.text) : clip.text).run();
}

/**
 * Offers what's on the clipboard as a chip on the current line when the editor gets
 * focus or the app comes back to the front: Paste, Paste as code, or dismiss.
 */
export function SmartPaste({ editor }: { editor: Editor }) {
  const [suggestion, setSuggestion] = useState<
    { clip: Clip; image?: undefined; key: string; top: number; left: number } | { clip?: undefined; image: File; key: string; top: number; left: number } | null
  >(null);
  const retry = useRef<number | undefined>(undefined);
  const retries = useRef(0);
  const tapped = useRef(false);

  // Every trigger goes through here. Triggers that arrive while a read is running are queued,
  // not dropped (dropping them was why the chip sometimes never showed after the first tap).
  const check = useMemo(
    () =>
      coalesce(async () => {
        if (!editor.isFocused) return;
        // On Android, copied media (a Gboard GIF often comes with a link as text) wins over text.
        const nativeImage = window.JournalClipboard ? await readClipboardImage() : null;
        const raw = nativeImage ? null : await readClipboard();
        if (!nativeImage && raw === null) {
          // The read failed (window not focused yet on Android): keep what's shown and try shortly.
          window.clearTimeout(retry.current);
          if (retries.current++ < MAX_RETRIES) retry.current = window.setTimeout(() => void check(), RETRY_MS);
          return;
        }
        retries.current = 0;
        await offer(raw, nativeImage);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );

  const offer = async (raw: string | null, nativeImage: File | null, force = false) => {
    const clip = classifyClip(raw);
    // With no text on the clipboard, look for a copied image.
    const image = nativeImage ?? (clip ? null : await readClipboardImage());
    if ((!clip && !image) || !editor.isFocused) return setSuggestion(null);
    const key = clip ? clipKey(raw!.trim()) : `img:${(await sha256(new Uint8Array(await image!.arrayBuffer()))).slice(0, 16)}`;
    if (!force && handledKeys().includes(key)) return setSuggestion(null);
    const at = editor.view.coordsAtPos(editor.state.selection.head);
    const place = { key, top: at.bottom + 6, left: Math.max(8, Math.min(at.left, window.innerWidth - 300)) };
    setSuggestion(clip ? { clip, ...place } : { image: image!, ...place });
  };

  useEffect(() => {
    const onFocus = () => {
      retries.current = 0;
      void check();
    };
    const onVisible = () => document.visibilityState === "visible" && onFocus();
    // Only the first tap after focusing checks: every Android clipboard read can show a notice.
    const onTap = () => {
      if (tapped.current) return;
      tapped.current = true;
      onFocus();
    };
    // Typing or leaving the editor hides the chip; it comes back on the next trigger.
    const hide = () => setSuggestion(null);
    const onBlur = () => {
      tapped.current = false;
      hide();
    };
    const dom = editor.view.dom;
    // Triggers: the editor gains focus; the app comes back (the editor may have kept focus, so
    // no focus event fires); the window regains focus (Android only allows clipboard reads then);
    // any tap into the page; and Android saying the clipboard changed.
    // Double-tap on an empty line: offer the clipboard again, even if it was already pasted or dismissed.
    const onDouble = () => {
      if (editor.state.selection.$from.parent.content.size) return;
      void (async () => {
        const image = window.JournalClipboard ? await readClipboardImage() : null;
        await offer(image ? null : await readClipboard(), image, true);
      })();
    };
    dom.addEventListener("dblclick", onDouble);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    editor.on("update", hide);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    dom.addEventListener("pointerup", onTap);
    const unDouble = () => dom.removeEventListener("dblclick", onDouble);
    window.__journalClipboardChanged = onFocus;
    return () => {
      unDouble();
      if (window.__journalClipboardChanged === onFocus) delete window.__journalClipboardChanged;
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
      editor.off("update", hide);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      dom.removeEventListener("pointerup", onTap);
      window.clearTimeout(retry.current);
    };
  }, [editor, check]);

  if (!suggestion) return null;
  const { clip, image, key } = suggestion;
  const act = (run: () => void) => {
    markHandled(key);
    setSuggestion(null);
    run();
  };
  // Keep the editor focused (and the phone keyboard up) while tapping the chip.
  const keepFocus = (e: PointerEvent | MouseEvent) => e.preventDefault();

  return (
    <div className="paste-chip" style={{ top: suggestion.top, left: suggestion.left }} role="group" aria-label="Paste from clipboard">
      {image ? (
        <>
          <span className="paste-preview">{image.type === "image/gif" ? "🎞️ Copied GIF" : image.type.startsWith("video/") ? "🎥 Copied video" : "🖼️ Copied image"}</span>
          <button type="button" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => act(() => void insertFiles(editor, [image]))}>
            {image.type === "image/gif" ? "Paste GIF" : "Paste"}
          </button>
        </>
      ) : (
        <>
          {clip.kind === "url" && youtubeId(clip.url) ? (
            <YoutubeCard url={clip.url} />
          ) : (
            <span className="paste-preview" title={clip.kind === "url" ? clip.url : clip.text}>
              📋 {clipPreview(clip, 28)}
            </span>
          )}
          <button type="button" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => act(() => insertClip(editor, clip, false))}>
            {clip.kind === "url" ? (youtubeId(clip.url) ? "Paste video" : "Paste link") : "Paste"}
          </button>
          {clip.kind === "url" && youtubeId(clip.url) && (
            <button
              type="button"
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => act(() => editor.chain().focus().insertContent({ type: "youtubeEmbed", attrs: { url: clip.url } }).run())}
            >
              ▶ As player
            </button>
          )}
          <button type="button" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => act(() => insertClip(editor, clip, true))}>
            As code
          </button>
        </>
      )}
      <button
        type="button"
        className="paste-dismiss"
        aria-label="Dismiss"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => act(() => {})}
      >
        ✕
      </button>
    </div>
  );
}
