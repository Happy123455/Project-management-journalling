import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { qrContent } from "../lib/capture";
import { embedText, parseEmbeds } from "../lib/embeds";
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

/** The block that shows a stored file: photo, video or PDF placed inline, anything else as a file card. */
export function mediaNode(r: FileRecord) {
  const kind = fileKind(r.mime);
  if (kind === "image") return { type: "attachmentImage", attrs: { fileId: r.id, name: r.name, align: "inline" } };
  if (kind === "video" || kind === "pdf") return { type: "attachmentMedia", attrs: { fileId: r.id, kind, name: r.name, mime: r.mime, size: r.size, align: "inline" } };
  return { type: "attachmentFile", attrs: { fileId: r.id, name: r.name, mime: r.mime, size: r.size } };
}

/** data-* attributes that let a copied photo, video, PDF or file be pasted back as itself. */
function mediaData(attrs: Record<string, unknown>) {
  const data: Record<string, string> = {};
  for (const key of ["fileId", "width", "align", "name", "mime", "size"]) {
    if (attrs[key] != null && attrs[key] !== "") data[`data-${key === "fileId" ? "file-id" : key}`] = String(attrs[key]);
  }
  return data;
}

/** Media blocks as Obsidian-style embeds in copied plain text: ![[attachments/<id>/<name>]]. */
export function mediaLeafText(node: PMNode): string {
  if (!["attachmentImage", "attachmentMedia", "attachmentFile"].includes(node.type.name)) return "";
  return embedText(node.attrs.fileId, node.attrs.name || "file", node.attrs.width);
}

/**
 * Pastes text holding ![[...]] embeds: each embed that names a stored file becomes that photo,
 * video, PDF or file again; unknown ones stay as text.
 */
export async function pasteEmbeds(editor: Editor, text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const paragraphs = [];
  for (const line of lines) {
    const content = [];
    for (const seg of parseEmbeds(line)) {
      if (seg.type === "text") {
        if (seg.text) content.push({ type: "text", text: seg.text });
        continue;
      }
      const file = await store?.findFile(seg.ref);
      if (!file) {
        content.push({ type: "text", text: `![[${seg.ref}]]` });
        continue;
      }
      const node = mediaNode(file);
      if (node.type === "attachmentFile") {
        // File cards are blocks: close the line so far and put the card on its own.
        if (content.length) paragraphs.push({ type: "paragraph", content: content.splice(0) });
        paragraphs.push(node);
      } else {
        content.push({ ...node, attrs: { ...node.attrs, ...(seg.width ? { width: seg.width } : {}) } });
      }
    }
    paragraphs.push({ type: "paragraph", content });
  }
  editor.chain().focus().insertContent(paragraphs).run();
}

/** Videos and PDFs added before they could be placed like photos become placeable ones. */
export function upgradeOldMedia(editor: Editor) {
  const { state } = editor;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "attachmentFile") return;
    const kind = fileKind(node.attrs.mime);
    if (kind !== "video" && kind !== "pdf") return;
    const media = state.schema.nodes.attachmentMedia.create({ ...node.attrs, kind, align: "inline" });
    const at = tr.mapping.map(pos);
    tr.replaceWith(at, at + node.nodeSize, state.schema.nodes.paragraph.create(null, media));
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** Saves picked, pasted or dropped files and puts them in the page at the cursor. */
export async function insertFiles(editor: Editor, files: File[]) {
  if (!store || !files.length) return;
  const records: FileRecord[] = [];
  for (const f of files) records.push(await store.saveFile({ name: f.name || "file", mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }));
  const nodes = records.map(mediaNode);
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

/** Opens the in-app camera (photos, videos, QR codes); what it captures goes in at the cursor. */
export function openCapture(editor: Editor) {
  window.dispatchEvent(new CustomEvent("journal:capture", { detail: { editor } }));
}

/** A scanned QR code at the cursor: links become tappable links. */
export function insertQr(editor: Editor, raw: string) {
  const { text, href } = qrContent(raw);
  editor
    .chain()
    .focus()
    .insertContent([{ type: "text", text, ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}) }, { type: "text", text: " " }])
    .run();
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

/** Shared frame for photos, videos and PDFs: width, placement, the resize handle and the placement toolbar. */
function PlacedMedia({ node, updateAttributes, selected, editor, children }: NodeViewProps & { children: ReactNode }) {
  const { width, align, x, y } = node.attrs as { width: number | null; align: Align; x: number; y: number };
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
        {children}
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

function ImageView(props: NodeViewProps) {
  const { url, failed } = useFileUrl(props.node.attrs.fileId);
  return (
    <PlacedMedia {...props}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="attach-missing">{failed ? "Image not found" : "Loading…"}</span>}
    </PlacedMedia>
  );
}

const placementAttributes = () => ({
  fileId: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-file-id") },
  name: { default: "image", parseHTML: (el: HTMLElement) => el.getAttribute("data-name") ?? "image" },
  width: { default: null, parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-width")) || null },
  align: { default: "inline", parseHTML: (el: HTMLElement) => el.getAttribute("data-align") ?? "inline" },
  x: { default: 0 },
  y: { default: 0 },
});

/** A stored photo (or GIF) in the page, with width and placement kept in the document. */
export const AttachmentImage = Node.create({
  name: "attachmentImage",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return placementAttributes();
  },
  parseHTML() {
    return [{ tag: "img[data-file-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, mediaData(node.attrs))];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

// ───────────── Videos and PDFs, placed like photos ─────────────

/** Ask the app to show a PDF full screen (the viewer lives in App). */
export function showPdf(fileId: string) {
  window.dispatchEvent(new CustomEvent("journal:open-pdf", { detail: { fileId } }));
}

/** Bytes of a stored file, for the PDF viewer. */
export const readFileBytes = (id: string) => store?.fileBytes(id) ?? Promise.resolve(null);
export const readFileRecord = (id: string) => store?.getFile(id) ?? Promise.resolve(null);
export { openFile };

function PdfPreview({ fileId, name }: { fileId: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let live = true;
    (async () => {
      const bytes = await store?.fileBytes(fileId);
      if (!bytes || !canvas.current) throw new Error("missing");
      const { openPdf, drawPage } = await import("./pdf");
      const doc = await openPdf(bytes);
      if (live && canvas.current) await drawPage(doc, 1, canvas.current, 480);
      if (live) setState("ready");
    })().catch(() => live && setState("failed"));
    return () => {
      live = false;
    };
  }, [fileId]);
  return (
    <span className="pdf-preview">
      <canvas ref={canvas} hidden={state !== "ready"} />
      {state !== "ready" && <span className="attach-missing">{state === "failed" ? `📕 ${name}` : "Loading PDF…"}</span>}
      <span className="pdf-badge">📕 {name}</span>
      <button
        type="button"
        className="pdf-open"
        aria-label="Open full screen"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          showPdf(fileId);
        }}
      >
        ⤢
      </button>
    </span>
  );
}

function MediaView(props: NodeViewProps) {
  const { fileId, kind, name } = props.node.attrs as { fileId: string; kind: "video" | "pdf"; name: string };
  const { url, failed } = useFileUrl(kind === "video" ? fileId : null);
  return (
    <PlacedMedia {...props}>
      {kind === "pdf" ? (
        <PdfPreview fileId={fileId} name={name} />
      ) : url ? (
        <video src={url} controls playsInline preload="metadata" />
      ) : (
        <span className="attach-missing">{failed ? "Video not found" : "Loading…"}</span>
      )}
    </PlacedMedia>
  );
}

/** A video or PDF with the same width and placement controls as photos. */
export const AttachmentMedia = Node.create({
  name: "attachmentMedia",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      ...placementAttributes(),
      kind: { default: "video", parseHTML: (el: HTMLElement) => el.getAttribute("data-media") ?? "video" },
      name: { default: "file", parseHTML: (el: HTMLElement) => el.getAttribute("data-name") ?? "file" },
      mime: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-mime") ?? "" },
      size: { default: 0, parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-size")) || 0 },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-media]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-media": node.attrs.kind, ...mediaData(node.attrs) }), node.attrs.name];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MediaView);
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
      name: { default: "file", parseHTML: (el) => el.getAttribute("data-name") ?? "file" },
      mime: { default: "", parseHTML: (el) => el.getAttribute("data-mime") ?? "" },
      size: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-size")) || 0 },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-attachment]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-attachment": "", ...mediaData(node.attrs) }), node.attrs.name];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileView);
  },
});
