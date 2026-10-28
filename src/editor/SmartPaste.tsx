import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import { sha256 } from "../lib/files";
import { classifyClip, clipKey, clipPreview, type Clip } from "../lib/smartPaste";
import { insertFiles } from "./attachments";

const HANDLED_KEY = "dynamic-journal.clipboard-handled";
const MAX_HANDLED = 50;

/** Clipboard text from the app (Tauri plugin) or the browser, or null when it can't be read. */
async function readClipboard(): Promise<string | null> {
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    }
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** An image on the clipboard as a PNG file, or null. */
async function readClipboardImage(): Promise<File | null> {
  try {
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
  if (clip.kind === "url") {
    return chain
      .insertContent([{ type: "text", text: clip.url, marks: [{ type: "link", attrs: { href: clip.url } }] }, { type: "text", text: " " }])
      .run();
  }
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
  const checking = useRef(false);

  const check = useCallback(async () => {
    if (checking.current || !editor.isFocused) return;
    checking.current = true;
    const raw = await readClipboard();
    const clip = classifyClip(raw);
    // With no text on the clipboard, look for a copied image.
    const image = clip ? null : await readClipboardImage();
    checking.current = false;
    if ((!clip && !image) || !editor.isFocused) return setSuggestion(null);
    const key = clip ? clipKey(raw!.trim()) : `img:${(await sha256(new Uint8Array(await image!.arrayBuffer()))).slice(0, 16)}`;
    if (handledKeys().includes(key)) return setSuggestion(null);
    const at = editor.view.coordsAtPos(editor.state.selection.head);
    const place = { key, top: at.bottom + 6, left: Math.max(8, Math.min(at.left, window.innerWidth - 300)) };
    setSuggestion(clip ? { clip, ...place } : { image: image!, ...place });
  }, [editor]);

  useEffect(() => {
    const onFocus = () => void check();
    const onVisible = () => document.visibilityState === "visible" && void check();
    // Typing or leaving the editor hides the chip; it comes back on the next focus.
    const hide = () => setSuggestion(null);
    editor.on("focus", onFocus);
    editor.on("blur", hide);
    editor.on("update", hide);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", hide);
      editor.off("update", hide);
      document.removeEventListener("visibilitychange", onVisible);
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
          <span className="paste-preview">🖼️ Copied image</span>
          <button type="button" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => act(() => void insertFiles(editor, [image]))}>
            Paste image
          </button>
        </>
      ) : (
        <>
          <span className="paste-preview" title={clip.kind === "url" ? clip.url : clip.text}>
            📋 {clipPreview(clip, 28)}
          </span>
          <button type="button" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => act(() => insertClip(editor, clip, false))}>
            {clip.kind === "url" ? "Paste link" : "Paste"}
          </button>
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
