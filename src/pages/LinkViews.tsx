import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { JournalEditor } from "../editor/JournalEditor";
import { mentionsWithChildren } from "../lib/links";
import { dayTitle } from "../lib/timestamp";
import { showError } from "../lib/toast";
import { ProjectPanel } from "../projects/ProjectPanel";
import { ProjectTimeline } from "../projects/ProjectTimeline";
import { mentionBlocks } from "../lib/mentionBlocks";
import { DocView } from "./DocView";
import type { JournalStore, LinkKind, NamedPage, Reference } from "../store";

const SAVE_DELAY_MS = 800;

export interface LinkHandlers {
  /** `line`: the text to scroll to and highlight there (a backlink's mention). */
  onOpenDay: (day: string, line?: string) => void;
  onOpenLink: (title: string) => void;
  onOpenTag: (tag: string) => void;
}

const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "2-digit" });

/**
 * One note that mentions the page or tag, as a compact row (where, and its first mentioning line);
 * the arrow opens the whole mention below it, like the rows of Entries.
 */
function ReferenceCard({ reference, kind, target, handlers }: { reference: Reference; kind: LinkKind; target: string; handlers: LinkHandlers }) {
  const [open, setOpen] = useState(false);
  // The mentioning parts with what's nested under them (a project's sub-points, a person's notes…).
  const lines = mentionsWithChildren(reference.content as never, kind, target);
  const blocks = mentionBlocks(reference.content as JSONContent, kind, target);
  const go = () => (reference.day ? handlers.onOpenDay(reference.day, lines[0]?.trim()) : handlers.onOpenLink(reference.title ?? ""));
  const first = blocks[0];
  return (
    <li className={`timeline-row reference-row${open ? " open" : ""}`}>
      <div className="reference-head">
        <button type="button" className="timeline-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="reference-caret" aria-hidden>{open ? "▾" : "▸"}</span>
          <span className="timeline-date">{reference.day ? shortDay(reference.day) : `📄 ${reference.title}`}</span>
          <span className="timeline-first">
            {first ? <DocView content={first} compact className="doc-line" onOpenLink={handlers.onOpenLink} onOpenTag={handlers.onOpenTag} /> : <span>{lines[0]?.trim()}</span>}
          </span>
          {blocks.length > 1 && <span className="reference-more">+{blocks.length - 1}</span>}
        </button>
        <button type="button" className="reference-go" onClick={go} aria-label="Go there" title="Go there">›</button>
      </div>
      {open && (
        <div className="timeline-body">
          <DocView content={blocks.slice(0, 40)} onOpenLink={handlers.onOpenLink} onOpenTag={handlers.onOpenTag} />
          <button type="button" onClick={go}>Open {reference.day ? dayTitle(reference.day) : reference.title} ›</button>
        </div>
      )}
    </li>
  );
}

function References({ store, kind, target, exclude, excludeDay, handlers, refreshKey, onCount }: {
  store: JournalStore;
  kind: LinkKind;
  target: string;
  exclude?: string;
  /** A day's own page doesn't count as its backlink. */
  excludeDay?: string;
  handlers: LinkHandlers;
  refreshKey?: unknown;
  onCount?: (n: number) => void;
}) {
  const [refs, setRefs] = useState<Reference[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    store.references(kind, target).then((r) => {
      if (cancelled) return;
      const list = r.filter((x) => x.blockId !== exclude && (!excludeDay || x.day !== excludeDay));
      setRefs(list);
      onCount?.(list.length);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, kind, target, exclude, refreshKey]);

  if (!refs) return null;
  if (!refs.length) {
    return <p className="hint">{kind === "tag" ? `Nothing tagged #${target} yet.` : `No notes link to [[${target}]] yet.`}</p>;
  }
  return (
    <ul className="references timeline compact-refs">
      {refs.map((r) => <ReferenceCard key={r.blockId} reference={r} kind={kind} target={target} handlers={handlers} />)}
    </ul>
  );
}

/**
 * The foot of every note: its backlinks (the notes that link to it, [[like this]] or to one of
 * its parts), folded to one line until opened.
 */
export function BacklinksFooter({ store, target, exclude, handlers, refreshKey, title = "Backlinks" }: {
  store: JournalStore;
  target: string;
  exclude?: string;
  handlers: LinkHandlers;
  refreshKey?: unknown;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    store.references("wikilink", target).then((r) => live && setCount(r.filter((x) => x.blockId !== exclude && x.day !== target).length));
    return () => {
      live = false;
    };
  }, [store, target, exclude, refreshKey]);
  return (
    <section className={`history backlinks-foot${open ? " open" : ""}`}>
      <button type="button" className="backlinks-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>↩ {title}</span>
        <span className="backlinks-count">{count ?? "…"}</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && <References store={store} kind="wikilink" target={target} exclude={exclude} excludeDay={target} handlers={handlers} refreshKey={refreshKey} onCount={setCount} />}
    </section>
  );
}

/** A person, project or topic: its own notes on top, then every day that mentions it (its history). */
export function PageView({ store, page, onBack, handlers, pageNames, find, onFindCount, onPageChanged }: {
  store: JournalStore;
  page: NamedPage;
  onBack: () => void;
  handlers: LinkHandlers;
  pageNames: () => Promise<string[]>;
  find?: { terms: string[]; index: number } | null;
  onFindCount?: (count: number) => void;
  onPageChanged: (page: NamedPage) => void;
}) {
  const pending = useRef<{ content: JSONContent; plainText: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState("");
  const [saves, setSaves] = useState(0);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    try {
      await store.savePage({ id: page.id, ...next });
      window.dispatchEvent(new Event("journal:saved"));
      setStatus("Saved");
      setSaves((n) => n + 1);
    } catch (e) {
      setStatus("");
      showError("Save failed", e);
    }
  }, [store, page.id]);

  // Never lose text: save when leaving the page.
  useEffect(() => () => void flush(), [flush]);

  const back = async () => {
    await flush();
    onBack();
  };

  return (
    <>
      <header className="page-header">
        <button type="button" onClick={back} aria-label="Back">‹</button>
        <h1>{page.props.project ? "📌" : "📄"} {page.title}</h1>
        <span className="status">{status}</span>
        {!page.props.project && (
          <button type="button" onClick={async () => onPageChanged(await store.setPageProps(page.id, { project: { status: "active" } }))} title="Track this as a project">
            📌 Project
          </button>
        )}
      </header>
      <div className="page-notes">
      <JournalEditor
        key={page.id}
        initialContent={page.content}
        onChange={(content, plainText, actor) => {
          window.clearTimeout(timer.current);
          if (actor) {
            // AI edits are saved at once as their own event, after anything typed before them.
            const before = pending.current;
            pending.current = null;
            void (async () => {
              if (before) await store.savePage({ id: page.id, ...before });
              await store.savePage({ id: page.id, content, plainText, actor });
              setSaves((n) => n + 1);
            })().catch((e) => showError("Save failed", e));
            return;
          }
          pending.current = { content, plainText };
          setStatus("Editing…");
          timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
        }}
        onOpenLink={async (t) => {
          await flush();
          handlers.onOpenLink(t);
        }}
        onOpenTag={async (t) => {
          await flush();
          handlers.onOpenTag(t);
        }}
        pageNames={pageNames}
        autofocus={false}
        find={find}
        onFindCount={onFindCount}
      />
      </div>
      {page.props.project && (
        <ProjectPanel store={store} page={page} refreshKey={saves} onChanged={onPageChanged} onOpenDay={handlers.onOpenDay} />
      )}
      {(
        // Every linked note records its days, like a project.
        <ProjectTimeline store={store} page={page} refreshKey={saves} onOpenDay={(d) => handlers.onOpenDay(d)} onOpenLink={handlers.onOpenLink} onOpenTag={handlers.onOpenTag} />
      )}
      <section className="history">
        <h2>Mentioned in</h2>
        <References store={store} kind="wikilink" target={page.title} exclude={page.id} handlers={handlers} refreshKey={saves} />
      </section>
    </>
  );
}

/** Everything carrying a #tag. */
export function TagView({ store, tag, onBack, handlers }: { store: JournalStore; tag: string; onBack: () => void; handlers: LinkHandlers }) {
  return (
    <>
      <header className="page-header">
        <button type="button" onClick={onBack} aria-label="Back">‹</button>
        <h1 className="tag-title">#{tag}</h1>
      </header>
      <References store={store} kind="tag" target={tag} handlers={handlers} />
    </>
  );
}

/** Backlinks for the Mac side panel. */
export function BacklinkList({ store, title, exclude, handlers }: { store: JournalStore; title: string; exclude?: string; handlers: LinkHandlers }) {
  return <References store={store} kind="wikilink" target={title} exclude={exclude} handlers={handlers} />;
}
