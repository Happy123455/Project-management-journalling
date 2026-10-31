import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fileKind } from "../lib/files";
import { dayTitle } from "../lib/timestamp";
import { openFile, showPdf, showPhoto, useFileUrl } from "../editor/attachments";
import type { ExtractedLinks } from "../lib/links";
import type { FileRecord, JournalStore } from "../store";

/** Every day with a page, newest first, today on top. */
export function DaysList({ days, day, today, onPick }: { days: string[]; day: string; today: string; onPick: (d: string) => void }) {
  return (
    <ul className="day-list">
      {[...new Set([today, ...days])].map((d) => (
        <li key={d}>
          <button type="button" className={d === day ? "active" : ""} onClick={() => onPick(d)}>
            {d === today ? "Today" : dayTitle(d).replace(/^\w+, /, "")}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Put stored files back into the open note: at a point on screen (a drop), or at the cursor. */
export type InsertMedia = (files: FileRecord[], at?: { x: number; y: number }) => void;

function MediaTile({ file, selecting, picked, onPick, onDragOut, dragIds }: {
  file: FileRecord;
  dragIds: string[];
  selecting: boolean;
  picked: boolean;
  onPick: () => void;
  /** Phone: hold, then drag out of the menu into the note. */
  onDragOut?: (e: React.PointerEvent) => void;
}) {
  const kind = fileKind(file.mime);
  const { url } = useFileUrl(kind === "image" || kind === "video" ? file.id : null, kind === "video");
  const hold = useRef<number | undefined>(undefined);
  const open = () => {
    if (selecting) return onPick();
    if (kind === "image" && url) showPhoto(url);
    else if (kind === "video" && url) showPhoto(url, "video");
    else if (kind === "pdf") showPdf(file.id);
    else void openFile(file.id);
  };
  return (
    <button
      type="button"
      className={`media-tile kind-${kind}${picked ? " picked" : ""}`}
      onClick={open}
      title={file.name}
      // Mac: drag tiles straight into the note.
      draggable
      onDragStart={(e) => e.dataTransfer.setData(MEDIA_DRAG, JSON.stringify(dragIds))}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch" || !onDragOut) return;
        e.persist?.();
        hold.current = window.setTimeout(() => onDragOut(e), 380);
      }}
      onPointerUp={() => window.clearTimeout(hold.current)}
      onPointerCancel={() => window.clearTimeout(hold.current)}
      onPointerMove={(e) => Math.abs(e.movementX) + Math.abs(e.movementY) > 6 && window.clearTimeout(hold.current)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {kind === "image" && url && <img src={url} alt="" loading="lazy" draggable={false} />}
      {kind === "video" && url && <video src={url} muted preload="metadata" />}
      {(kind === "pdf" || kind === "file") && <span className="media-tile-icon">{kind === "pdf" ? "📕" : "📎"}</span>}
      {kind !== "image" && <span className="media-tile-name">{kind === "video" ? "🎥 " : ""}{file.name}</span>}
      {selecting && <span className="media-check" aria-hidden>{picked ? "✓" : ""}</span>}
    </button>
  );
}

/** The drag type for tiles dragged from the Media tab into the note (a JSON list of file ids). */
export const MEDIA_DRAG = "application/x-journal-files";

/** Photos, videos, GIFs, PDFs and files: the ones on this page, or everything in the journal. */
export function MediaGrid({ store, ids, onInsert }: { store: JournalStore; ids: string[]; onInsert?: InsertMedia }) {
  const [all, setAll] = useState(false);
  const [files, setFiles] = useState<FileRecord[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [ghost, setGhost] = useState<{ x: number; y: number; n: number } | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    let live = true;
    (all ? store.listFiles() : Promise.all(ids.map((id) => store.getFile(id))).then((f) => f.filter((x): x is FileRecord => !!x))).then(
      (f) => live && setFiles(f),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, all]);

  const chosen = (extra?: FileRecord) => {
    const list = (files ?? []).filter((f) => picked.includes(f.id));
    return extra && !picked.includes(extra.id) ? [...list, extra] : list;
  };
  const done = () => {
    setSelecting(false);
    setPicked([]);
  };
  // Hold a tile, then drag: the menu slides away and the tiles follow the finger to where they go.
  const dragOut = (file: FileRecord) => (start: React.PointerEvent) => {
    if (!onInsert) return;
    const list = chosen(file);
    navigator.vibrate?.(15);
    setGhost({ x: start.clientX, y: start.clientY, n: list.length });
    window.dispatchEvent(new Event("journal:close-drawer"));
    // Touch events, so the drag can stop the list from scrolling instead of being cancelled by it.
    let last = { x: start.clientX, y: start.clientY };
    const move = (e: TouchEvent) => {
      e.preventDefault();
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setGhost({ ...last, n: list.length });
    };
    const end = (e: TouchEvent) => {
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      setGhost(null);
      if (e.type === "touchend") onInsert(list, last);
      done();
    };
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  };

  return (
    <div className="media-panel">
      <div className="media-scope" role="tablist">
        <button type="button" role="tab" aria-selected={!all} className={!all ? "active" : ""} onClick={() => setAll(false)}>This page</button>
        <button type="button" role="tab" aria-selected={all} className={all ? "active" : ""} onClick={() => setAll(true)}>All media</button>
        {onInsert && !!files?.length && (
          <button type="button" className={selecting ? "active" : ""} onClick={() => (selecting ? done() : setSelecting(true))}>
            {selecting ? "Cancel" : "Select"}
          </button>
        )}
      </div>
      {onInsert && !!files?.length && <p className="hint">{selecting ? "Tap to pick, then Add. Or hold and drag into the note." : "Hold a tile and drag it into the note, or Select to add several."}</p>}
      {files && !files.length && <p className="hint">{all ? "No media in the journal yet." : "No photos, videos or files on this page."}</p>}
      <div className="media-grid">
        {files?.map((f) => (
          <MediaTile
            key={f.id}
            file={f}
            selecting={selecting}
            picked={picked.includes(f.id)}
            dragIds={picked.includes(f.id) ? picked : [f.id]}
            onPick={() => setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]))}
            onDragOut={onInsert ? dragOut(f) : undefined}
          />
        ))}
      </div>
      {selecting && picked.length > 0 && onInsert && (
        <button
          type="button"
          className="media-add"
          onClick={() => {
            onInsert(chosen());
            done();
          }}
        >
          Add {picked.length} to the note
        </button>
      )}
      {ghost && createPortal(
        <div className="media-ghost" style={{ transform: `translate3d(${ghost.x - 34}px, ${ghost.y - 34}px, 0)` }}>
          {ghost.n > 1 ? ghost.n : "＋"}
        </div>,
        document.body,
      )}
    </div>
  );
}

type Tab = "links" | "tags" | "media";

interface TagNode {
  path: string;
  name: string;
  children: TagNode[];
}

/** #a/b/c tags as a tree: a → b → c (every level its own node, children sorted). */
export function tagTree(tags: string[]): TagNode[] {
  const root: TagNode[] = [];
  for (const tag of tags) {
    let level = root;
    let path = "";
    for (const name of tag.split("/").filter(Boolean)) {
      path = path ? `${path}/${name}` : name;
      let node = level.find((n) => n.name.toLowerCase() === name.toLowerCase());
      if (!node) level.push((node = { path, name, children: [] }));
      level = node.children;
    }
  }
  const sort = (nodes: TagNode[]) => nodes.sort((a, b) => a.name.localeCompare(b.name)).forEach((n) => sort(n.children));
  sort(root);
  return root;
}

/** Nested tags, foldable; tapping a parent shows everything under it. */
function TagTree({ tags, onOpenTag }: { tags: string[]; onOpenTag: (t: string) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const render = (nodes: TagNode[]) => (
    <ul className="panel-list tag-tree">
      {nodes.map((n) => (
        <li key={n.path}>
          {n.children.length > 0 ? (
            <button
              type="button"
              className="tag-fold"
              aria-label={closed.has(n.path) ? "Expand" : "Collapse"}
              onClick={() => setClosed((c) => (c.has(n.path) ? new Set([...c].filter((x) => x !== n.path)) : new Set([...c, n.path])))}
            >
              {closed.has(n.path) ? "▸" : "▾"}
            </button>
          ) : (
            <span className="tag-fold" />
          )}
          <button type="button" className="tag link-button" onClick={() => onOpenTag(n.path)}>#{n.name}</button>
          {n.children.length > 0 && !closed.has(n.path) && render(n.children)}
        </li>
      ))}
    </ul>
  );
  return render(tagTree(tags));
}

/** Links, Tags and Media for the page on screen. */
export function InfoTabs({ links, mediaIds, store, onOpenLink, onOpenTag, backlinks, onInsertMedia }: {
  links: ExtractedLinks;
  mediaIds: string[];
  store: JournalStore | null;
  onOpenLink: (t: string) => void;
  onOpenTag: (t: string) => void;
  /** On a person's or topic's page, the days that mention it. */
  backlinks?: ReactNode;
  onInsertMedia?: InsertMedia;
}) {
  const [tab, setTab] = useState<Tab>("links");
  return (
    <div className="info-tabs">
      <div className="panel-tabs" role="tablist">
        {(["links", "tags", "media"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "links" ? "Links" : t === "tags" ? "Tags" : "Media"}
          </button>
        ))}
      </div>
      {tab === "links" && (
        <>
          {links.wikilinks.length ? (
            <ul className="panel-list">
              {links.wikilinks.map((l) => (
                <li key={l}>
                  <button type="button" className="wikilink link-button" onClick={() => onOpenLink(l)}>[[{l}]]</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Type [[ ]] around a name to link it.</p>
          )}
          {backlinks && (
            <>
              <h3>Mentioned in</h3>
              {backlinks}
            </>
          )}
        </>
      )}
      {tab === "tags" &&
        (links.tags.length ? (
          <TagTree tags={links.tags} onOpenTag={onOpenTag} />
        ) : (
          <p className="hint">Type #idea to tag.</p>
        ))}
      {tab === "media" && store && <MediaGrid store={store} ids={mediaIds} onInsert={onInsertMedia} />}
    </div>
  );
}

/** Phone: slides in from the left with Days, then Links / Tags / Media. */
export function Drawer({ open, onClose, top, bottom, children }: { open: boolean; onClose: () => void; top?: ReactNode; bottom?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <>
      <div className={open ? "drawer-backdrop open" : "drawer-backdrop"} onClick={onClose} />
      <aside className={open ? "drawer open" : "drawer"} aria-hidden={!open}>
        {top}
        <div className="drawer-scroll">{children}</div>
        {bottom}
      </aside>
    </>
  );
}
