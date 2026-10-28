import { useEffect, useState, type ReactNode } from "react";
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

function MediaTile({ file }: { file: FileRecord }) {
  const kind = fileKind(file.mime);
  const { url } = useFileUrl(kind === "image" || kind === "video" ? file.id : null);
  const open = () => {
    if (kind === "image" && url) showPhoto(url);
    else if (kind === "video" && url) showPhoto(url, "video");
    else if (kind === "pdf") showPdf(file.id);
    else void openFile(file.id);
  };
  return (
    <button type="button" className={`media-tile kind-${kind}`} onClick={open} title={file.name}>
      {kind === "image" && url && <img src={url} alt="" loading="lazy" />}
      {kind === "video" && url && <video src={url} muted preload="metadata" />}
      {(kind === "pdf" || kind === "file") && <span className="media-tile-icon">{kind === "pdf" ? "📕" : "📎"}</span>}
      {kind !== "image" && <span className="media-tile-name">{kind === "video" ? "🎥 " : ""}{file.name}</span>}
    </button>
  );
}

/** Photos, videos, GIFs, PDFs and files: the ones on this page, or everything in the journal. */
export function MediaGrid({ store, ids }: { store: JournalStore; ids: string[] }) {
  const [all, setAll] = useState(false);
  const [files, setFiles] = useState<FileRecord[] | null>(null);
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

  return (
    <div className="media-panel">
      <div className="media-scope" role="tablist">
        <button type="button" role="tab" aria-selected={!all} className={!all ? "active" : ""} onClick={() => setAll(false)}>This page</button>
        <button type="button" role="tab" aria-selected={all} className={all ? "active" : ""} onClick={() => setAll(true)}>All media</button>
      </div>
      {files && !files.length && <p className="hint">{all ? "No media in the journal yet." : "No photos, videos or files on this page."}</p>}
      <div className="media-grid">{files?.map((f) => <MediaTile key={f.id} file={f} />)}</div>
    </div>
  );
}

type Tab = "links" | "tags" | "media";

/** Links, Tags and Media for the page on screen. */
export function InfoTabs({ links, mediaIds, store, onOpenLink, onOpenTag, backlinks }: {
  links: ExtractedLinks;
  mediaIds: string[];
  store: JournalStore | null;
  onOpenLink: (t: string) => void;
  onOpenTag: (t: string) => void;
  /** On a person's or topic's page, the days that mention it. */
  backlinks?: ReactNode;
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
          <ul className="panel-list">
            {links.tags.map((t) => (
              <li key={t}>
                <button type="button" className="tag link-button" onClick={() => onOpenTag(t)}>#{t}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Type #idea to tag.</p>
        ))}
      {tab === "media" && store && <MediaGrid store={store} ids={mediaIds} />}
    </div>
  );
}

/** Phone: slides in from the left with Days, then Links / Tags / Media. */
export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
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
        {children}
      </aside>
    </>
  );
}
