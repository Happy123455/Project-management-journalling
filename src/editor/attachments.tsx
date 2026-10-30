import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { qrContent } from "../lib/capture";
import { AlphaVideo } from "./AlphaVideo";
import { AudioPill, PeekOnDoubleTap, TapVideo } from "./MediaBits";
import { usePlayWhenVisible } from "./usePlayWhenVisible";
import { embedText, parseEmbeds } from "../lib/embeds";
import { placeBar } from "../lib/placement";
import { fileKind, formatSize } from "../lib/files";
import type { FileRecord, JournalStore } from "../store";

// ───────────── Where attachments come from ─────────────

let store: JournalStore | null = null;
const urls = new Map<string, Promise<string>>();

/** The app hands its store over once it's open; attachment blocks read and save through it. */
export function setAttachmentStore(s: JournalStore) {
  store = s;
}

/** The open journal, for blocks that save elsewhere (e.g. the YouTube watch log). */
export const journalStore = () => store;

/** A displayable URL for a stored file (cached for the session). */
export function fileUrl(id: string): Promise<string> {
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

export function useFileUrl(id: string | null) {
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
  if (kind === "video" || kind === "pdf" || kind === "audio") return { type: "attachmentMedia", attrs: { fileId: r.id, kind, name: r.name, mime: r.mime, size: r.size, align: "inline" } };
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
  if (node.type.name === "youtubeEmbed") return `![${node.attrs.width ? `|${node.attrs.width}` : ""}](${node.attrs.url})`;
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

/**
 * Follows a press until it's released: reports how far it moved, then calls `onEnd`.
 * Works the same for mouse, pen and finger.
 */
function dragFrom(event: ReactPointerEvent, onMove: (dx: number, dy: number) => void, onEnd: () => void) {
  event.preventDefault();
  event.stopPropagation();
  const x0 = event.clientX;
  const y0 = event.clientY;
  const move = (e: PointerEvent) => {
    e.preventDefault();
    onMove(e.clientX - x0, e.clientY - y0);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onEnd();
  };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** Pixels the status bar covers at the top (the CSS safe-area inset, measured with a probe). */
function safeTop(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top, 0px)";
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return px;
}

/** Media node views let the editor ignore presses on their handles and bars, so drags aren't eaten. */
export const mediaNodeViewOptions = {
  stopEvent: ({ event }: { event: Event }) =>
    // Taps on a video or audio player go to the player: they play it without moving the cursor or
    // opening the keyboard.
    !!(event.target as HTMLElement | null)?.closest?.(".attach-resize, .attach-toolbar, .attach-draggable, video, audio, canvas, iframe, .audio-pill, .peek-host, .tap-video, .yt-embed"),
};

/** Shared frame for photos, videos and PDFs: width, placement, the resize handle and the placement toolbar. */
export function PlacedMedia({ node, updateAttributes, selected, editor, getPos, children }: NodeViewProps & { children: ReactNode }) {
  const { width, align, x, y } = node.attrs as { width: number | null; align: Align; x: number; y: number };
  const box = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const editable = editor.isEditable;
  // While dragging, the size and position change on screen only; the page is saved once at the end.
  const [live, setLive] = useState<{ width?: number; dx: number; dy: number } | null>(null);
  const [barAt, setBarAt] = useState<{ x: number; y: number } | null>(null);
  const showTools = selected && editable;
  const draggable = showTools && align === "free";
  // Saving the new size or position replaces the node; select it again so it can be dragged again.
  const commit = (attrs: Record<string, unknown>) => {
    updateAttributes(attrs);
    const pos = getPos();
    if (typeof pos === "number") editor.commands.setNodeSelection(pos);
  };

  const resize = (e: ReactPointerEvent) => {
    const start = box.current?.getBoundingClientRect().width ?? 200;
    let next = start;
    dragFrom(
      e,
      (dx) => {
        next = Math.max(60, Math.min(window.innerWidth - 16, Math.round(start + dx)));
        setLive({ width: next, dx: 0, dy: 0 });
      },
      () => {
        setLive(null);
        commit({ width: next });
      },
    );
  };
  const move = (e: ReactPointerEvent) => {
    if (!draggable) return;
    let moved = { dx: 0, dy: 0 };
    dragFrom(
      e,
      (dx, dy) => {
        moved = { dx, dy };
        setLive({ dx, dy });
      },
      () => {
        setLive(null);
        if (moved.dx || moved.dy) commit({ x: x + moved.dx, y: y + moved.dy });
      },
    );
  };

  // Keep the placement bar on screen: above the picture, slid in from the edges, or below it.
  useLayoutEffect(() => {
    if (!showTools) return setBarAt(null);
    const place = () => {
      const target = box.current?.getBoundingClientRect();
      const size = bar.current?.getBoundingClientRect();
      if (!target || !size) return;
      const vv = window.visualViewport;
      const p = placeBar(target, size, { width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight, top: safeTop() });
      setBarAt({ x: p.x, y: p.y });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [showTools, width, align, x, y, live]);

  const shownWidth = live?.width ?? width;
  const dx = x + (live?.dx ?? 0);
  const dy = y + (live?.dy ?? 0);
  return (
    <NodeViewWrapper
      as="span"
      className={`attach-image align-${align}${selected ? " selected" : ""}${live ? " dragging" : ""}`}
      style={{ width: shownWidth ? `${shownWidth}px` : undefined, transform: align === "free" ? `translate(${dx}px, ${dy}px)` : undefined }}
      data-drag-handle={align === "free" ? undefined : ""}
    >
      <span ref={box} className={draggable ? "attach-image-box attach-draggable" : "attach-image-box"} onPointerDown={move}>
        {children}
        {showTools && <span className="attach-resize" onPointerDown={resize} aria-label="Resize" />}
      </span>
      {showTools && (
        <span
          ref={bar}
          className="attach-toolbar"
          contentEditable={false}
          style={barAt ? { left: barAt.x, top: barAt.y, transform: "none" } : { visibility: "hidden" }}
        >
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

/** Ask the app to show a photo full screen (the viewer lives in App). */
export function showPhoto(url: string, kind: "image" | "video" = "image") {
  window.dispatchEvent(new CustomEvent("journal:open-photo", { detail: { url, kind } }));
}

function ImageView(props: NodeViewProps) {
  const { url, failed } = useFileUrl(props.node.attrs.fileId);
  const lastTap = useRef(0);
  // Double-click (Mac) or double-tap (phone) opens the photo full screen.
  const onTapEnd = (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch" || !url) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      showPhoto(url);
    } else {
      lastTap.current = now;
    }
  };
  return (
    <PlacedMedia {...props}>
      {url ? (
        <img src={url} alt="" draggable={false} onDoubleClick={() => showPhoto(url)} onPointerUp={onTapEnd} />
      ) : (
        <span className="attach-missing">{failed ? "Image not found" : "Loading…"}</span>
      )}
    </PlacedMedia>
  );
}

export const placementAttributes = () => ({
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
    return ReactNodeViewRenderer(ImageView, mediaNodeViewOptions);
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

/** Selects a media node without focusing the text (no keyboard) or scrolling. */
export function selectMedia({ editor, getPos }: NodeViewProps) {
  const pos = getPos();
  if (typeof pos === "number" && editor.isEditable) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

/** A meme/GIF clip: loops silently, and only while on screen. */
function LoopingClip({ src }: { src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  usePlayWhenVisible(video, [src]);
  return <video ref={video} src={src} autoPlay loop muted playsInline />;
}

function MediaView(props: NodeViewProps) {
  const { fileId, kind, name } = props.node.attrs as { fileId: string; kind: "video" | "pdf" | "audio"; name: string };
  const { url, failed } = useFileUrl(kind === "video" || kind === "audio" ? fileId : null);
  return (
    <PlacedMedia {...props}>
      {kind === "pdf" ? (
        <PdfPreview fileId={fileId} name={name} />
      ) : kind === "audio" ? (
        url ? (
          <AudioPill src={url} icon={name.startsWith("sound-") ? "🔊" : "🎙"} />
        ) : (
          <span className="attach-missing">{failed ? "Recording not found" : "Loading…"}</span>
        )
      ) : url ? (
        // Meme clips loop silently like GIFs; green-screen ones are drawn see-through; other videos get controls.
        name.startsWith("greenscreen-") ? (
          <PeekOnDoubleTap peek={() => <AlphaVideo src={url} />}>
            <AlphaVideo src={url} onTap={() => selectMedia(props)} />
          </PeekOnDoubleTap>
        ) : name.startsWith("meme-") || /^gif-/.test(name) ? (
          <PeekOnDoubleTap peek={() => <video src={url} autoPlay loop playsInline controls />}>
            <LoopingClip src={url} />
          </PeekOnDoubleTap>
        ) : (
          <TapVideo src={url} onSelect={() => selectMedia(props)} />
        )
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
    return ReactNodeViewRenderer(MediaView, mediaNodeViewOptions);
  },
});

// ───────────── File block (PDFs, videos, anything else) ─────────────

function FileView(props: NodeViewProps) {
  const { node } = props;
  const { fileId, name, mime, size } = node.attrs as { fileId: string; name: string; mime: string; size: number };
  const kind = fileKind(mime);
  const { url } = useFileUrl(kind === "video" ? fileId : null);
  return (
    <NodeViewWrapper className={`attach-file kind-${kind}`} data-drag-handle="">
      {kind === "video" && url ? (
        // Meme clips loop silently like GIFs; green-screen ones are drawn see-through; other videos get controls.
        name.startsWith("greenscreen-") ? (
          <PeekOnDoubleTap peek={() => <AlphaVideo src={url} />}>
            <AlphaVideo src={url} onTap={() => selectMedia(props)} />
          </PeekOnDoubleTap>
        ) : name.startsWith("meme-") || /^gif-/.test(name) ? (
          <PeekOnDoubleTap peek={() => <video src={url} autoPlay loop playsInline controls />}>
            <LoopingClip src={url} />
          </PeekOnDoubleTap>
        ) : (
          <TapVideo src={url} onSelect={() => selectMedia(props)} />
        )
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
    return ReactNodeViewRenderer(FileView, mediaNodeViewOptions);
  },
});
