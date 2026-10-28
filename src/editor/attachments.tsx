import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from "@tiptap/react";
import { fileKind, formatSize } from "../lib/files";
import type { FileRecord, JournalStore } from "../store";

// ───────────── Where attachments come from ─────────────

let store: JournalStore | null = null;
const urls = new Map<string, Promise<string>>();

/** The app hands its store over once it's open; attachment blocks read and save through it. */
export function setAttachmentStore(s: JournalStore) {
  store = s;
}

/** A displayable URL for a stored file (cached for the session). */
function fileUrl(id: string): Promise<string> {
  let url = urls.get(id);
  if (!url) {
    url = (async () => {
      const [file, bytes] = await Promise.all([store?.getFile(id), store?.fileBytes(id)]);
      if (!file || !bytes) throw new Error("missing file");
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mime }));
    })();
    urls.set(id, url);
  }
  return url;
}

function useFileUrl(id: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!id) return;
    let live = true;
    fileUrl(id).then((u) => live && setUrl(u)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id]);
  return { url, failed };
}

/** Opens a file in the phone's or Mac's own viewer (PDFs, documents). */
async function openFile(id: string) {
  const file = await store?.getFile(id);
  if (!file) return;
  if ("__TAURI_INTERNALS__" in window) {
    const [{ openPath }, { appDataDir, join }] = await Promise.all([import("@tauri-apps/plugin-opener"), import("@tauri-apps/api/path")]);
    try {
      await openPath(await join(await appDataDir(), file.path));
    } catch {
      alert(`No app on this device could open “${file.name}”.`);
    }
  } else {
    window.open(await fileUrl(id), "_blank");
  }
}

/** Saves picked, pasted or dropped files and puts them in the page at the cursor. */
export async function insertFiles(editor: Editor, files: File[]) {
  if (!store || !files.length) return;
  const records: FileRecord[] = [];
  for (const f of files) records.push(await store.saveFile({ name: f.name || "file", mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }));
  const nodes = records.map((r) =>
    fileKind(r.mime) === "image"
      ? { type: "attachmentImage", attrs: { fileId: r.id, align: "center" } }
      : { type: "attachmentFile", attrs: { fileId: r.id, name: r.name, mime: r.mime, size: r.size } },
  );
  editor.chain().focus().insertContent(nodes).run();
}

/** Opens the system picker (files, or the camera with `capture`) and inserts what was chosen. */
export function pickFiles(editor: Editor, accept: string, capture?: "environment") {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = !capture;
  if (capture) input.setAttribute("capture", capture);
  input.style.display = "none";
  input.addEventListener("change", () => {
    void insertFiles(editor, [...(input.files ?? [])]);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

/** Scans a QR code with the phone camera and inserts it: links become tappable links. */
export async function scanQr(editor: Editor) {
  if (!("__TAURI_INTERNALS__" in window)) return alert("QR scanning works in the phone app.");
  const scanner = await import("@tauri-apps/plugin-barcode-scanner");
  try {
    if ((await scanner.checkPermissions()) !== "granted" && (await scanner.requestPermissions()) !== "granted") return;
    const { content } = await scanner.scan({ formats: [scanner.Format.QRCode] });
    const text = content.trim();
    const isUrl = /^https?:\/\/\S+$/i.test(text);
    editor
      .chain()
      .focus()
      .insertContent({
        type: "paragraph",
        content: [{ type: "text", text, ...(isUrl ? { marks: [{ type: "link", attrs: { href: text } }] } : {}) }],
      })
      .run();
  } catch {
    // Scan cancelled.
  }
}

// ───────────── Image block ─────────────

type Align = "inline" | "left" | "center" | "right" | "free";
const ALIGNS: { value: Align; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
  { value: "inline", label: "Inline" },
  { value: "free", label: "Free" },
];

/** Drag from `start`, reporting how far the pointer moved, until it's released. */
function dragFrom(event: ReactPointerEvent, onMove: (dx: number, dy: number) => void) {
  event.preventDefault();
  event.stopPropagation();
  const x0 = event.clientX;
  const y0 = event.clientY;
  const move = (e: PointerEvent) => onMove(e.clientX - x0, e.clientY - y0);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function ImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { fileId, width, align, x, y } = node.attrs as { fileId: string; width: number | null; align: Align; x: number; y: number };
  const { url, failed } = useFileUrl(fileId);
  const box = useRef<HTMLSpanElement>(null);
  const editable = editor.isEditable;

  const resize = (e: ReactPointerEvent) => {
    const start = box.current?.getBoundingClientRect().width ?? 200;
    dragFrom(e, (dx) => updateAttributes({ width: Math.max(60, Math.round(start + dx)) }));
  };
  const move = (e: ReactPointerEvent) => {
    if (align !== "free" || !selected) return;
    dragFrom(e, (dx, dy) => updateAttributes({ x: x + dx, y: y + dy }));
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`attach-image align-${align}${selected ? " selected" : ""}`}
      style={{ width: width ? `${width}px` : undefined, transform: align === "free" ? `translate(${x}px, ${y}px)` : undefined }}
      data-drag-handle={align === "free" ? undefined : ""}
    >
      <span ref={box} className="attach-image-box" onPointerDown={move}>
        {url ? <img src={url} alt="" draggable={false} /> : <span className="attach-missing">{failed ? "Image not found" : "Loading…"}</span>}
        {selected && editable && <span className="attach-resize" onPointerDown={resize} aria-label="Resize" />}
      </span>
      {selected && editable && (
        <span className="attach-toolbar" contentEditable={false}>
          {ALIGNS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={a.value === align ? "active" : ""}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => updateAttributes({ align: a.value, ...(a.value === "free" ? {} : { x: 0, y: 0 }) })}
            >
              {a.label}
            </button>
          ))}
        </span>
      )}
    </NodeViewWrapper>
  );
}

/** A stored photo in the page, with width and placement kept in the document. */
export const AttachmentImage = Node.create({
  name: "attachmentImage",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (el) => el.getAttribute("data-file-id") },
      width: { default: null, parseHTML: (el) => Number(el.getAttribute("data-width")) || null },
      align: { default: "center", parseHTML: (el) => el.getAttribute("data-align") ?? "center" },
      x: { default: 0 },
      y: { default: 0 },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-file-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { "data-file-id": node.attrs.fileId, "data-width": node.attrs.width, "data-align": node.attrs.align })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

// ───────────── File block (PDFs, videos, anything else) ─────────────

function FileView({ node }: NodeViewProps) {
  const { fileId, name, mime, size } = node.attrs as { fileId: string; name: string; mime: string; size: number };
  const kind = fileKind(mime);
  const { url } = useFileUrl(kind === "video" ? fileId : null);
  return (
    <NodeViewWrapper className={`attach-file kind-${kind}`} data-drag-handle="">
      {kind === "video" && url ? (
        <video src={url} controls playsInline preload="metadata" />
      ) : (
        <button type="button" className="attach-file-card" contentEditable={false} onClick={() => void openFile(fileId)}>
          <span className="attach-file-icon">{kind === "pdf" ? "📕" : kind === "video" ? "🎥" : "📎"}</span>
          <span className="attach-file-name">{name}</span>
          <span className="attach-file-size">{formatSize(size)}</span>
        </button>
      )}
    </NodeViewWrapper>
  );
}

export const AttachmentFile = Node.create({
  name: "attachmentFile",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (el) => el.getAttribute("data-file-id") },
      name: { default: "file" },
      mime: { default: "" },
      size: { default: 0 },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-attachment]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-attachment": "", "data-file-id": node.attrs.fileId }), node.attrs.name];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileView);
  },
});
