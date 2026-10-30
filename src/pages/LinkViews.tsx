import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { JournalEditor } from "../editor/JournalEditor";
import { mentionsWithChildren } from "../lib/links";
import { dayTitle } from "../lib/timestamp";
import { showError } from "../lib/toast";
import { ProjectPanel } from "../projects/ProjectPanel";
import { ProjectTimeline } from "../projects/ProjectTimeline";
import { MediaPeek, mediaItemsIn } from "../editor/MediaPeek";
import { InspirationGrid } from "./InspirationGrid";
import type { JournalStore, LinkKind, NamedPage, Reference } from "../store";

const SAVE_DELAY_MS = 800;

export interface LinkHandlers {
  /** `line`: the text to scroll to and highlight there (a backlink's mention). */
  onOpenDay: (day: string, line?: string) => void;
  onOpenLink: (title: string) => void;
  onOpenTag: (tag: string) => void;
}

/** One block that mentions the page or tag: where it is, and the lines that mention it. */
function ReferenceCard({ reference, kind, target, handlers }: { reference: Reference; kind: LinkKind; target: string; handlers: LinkHandlers }) {
  // The mentioning lines with what's nested under them (a project's sub-points, a person's notes…).
  const taken: never[] = [];
  const lines = mentionsWithChildren(reference.content as never, kind, target, taken);
  const media = mediaItemsIn(taken);
  const open = () => (reference.day ? handlers.onOpenDay(reference.day, lines[0]?.trim()) : handlers.onOpenLink(reference.title ?? ""));
  return (
    <li>
      <button type="button" className="reference" onClick={open}>
        <span className="reference-where">{reference.day ? dayTitle(reference.day) : `📄 ${reference.title}`}</span>
        {lines.slice(0, 12).map((line, i) => (
          <span key={i} className="reference-line" style={{ paddingLeft: `${(line.match(/^ */)![0].length / 2) * 14}px` }}>{line.trim()}</span>
        ))}
      </button>
      <MediaPeek items={media} />
    </li>
  );
}

function References({ store, kind, target, exclude, handlers, refreshKey }: {
  store: JournalStore;
  kind: LinkKind;
  target: string;
  exclude?: string;
  handlers: LinkHandlers;
  refreshKey?: unknown;
}) {
  const [refs, setRefs] = useState<Reference[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    store.references(kind, target).then((r) => !cancelled && setRefs(r.filter((x) => x.blockId !== exclude)));
    return () => {
      cancelled = true;
    };
  }, [store, kind, target, exclude, refreshKey]);

  if (!refs) return null;
  if (!refs.length) {
    return <p className="hint">{kind === "tag" ? `Nothing tagged #${target} yet.` : `No days mention [[${target}]] yet.`}</p>;
  }
  return (
    <ul className="references">
      {refs.map((r) => <ReferenceCard key={r.blockId} reference={r} kind={kind} target={target} handlers={handlers} />)}
    </ul>
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
  // The page as last saved (the grid on the Inspiration page follows edits).
  const [latest, setLatest] = useState<JSONContent | null>(null);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    try {
      await store.savePage({ id: page.id, ...next });
      setLatest(next.content);
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
      {page.title.toLowerCase() === "inspiration" && (
        <InspirationGrid key={saves} content={latest ?? page.content} />
      )}
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
      {page.props.project && (
        <ProjectTimeline store={store} page={page} refreshKey={saves} onOpenDay={(d) => handlers.onOpenDay(d)} />
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
