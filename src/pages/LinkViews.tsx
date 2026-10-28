import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { JournalEditor } from "../editor/JournalEditor";
import { linesMentioning } from "../lib/links";
import { dayTitle } from "../lib/timestamp";
import { showError } from "../lib/toast";
import { docText } from "../lib/words";
import type { JournalStore, LinkKind, NamedPage, Reference } from "../store";

const SAVE_DELAY_MS = 800;

export interface LinkHandlers {
  onOpenDay: (day: string) => void;
  onOpenLink: (title: string) => void;
  onOpenTag: (tag: string) => void;
}

/** One block that mentions the page or tag: where it is, and the lines that mention it. */
function ReferenceCard({ reference, kind, target, handlers }: { reference: Reference; kind: LinkKind; target: string; handlers: LinkHandlers }) {
  const lines = linesMentioning(docText(reference.content), kind, target);
  const open = () => (reference.day ? handlers.onOpenDay(reference.day) : handlers.onOpenLink(reference.title ?? ""));
  return (
    <li>
      <button type="button" className="reference" onClick={open}>
        <span className="reference-where">{reference.day ? dayTitle(reference.day) : `📄 ${reference.title}`}</span>
        {lines.slice(0, 4).map((line, i) => (
          <span key={i} className="reference-line">{line}</span>
        ))}
      </button>
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
export function PageView({ store, page, onBack, handlers, pageNames }: {
  store: JournalStore;
  page: NamedPage;
  onBack: () => void;
  handlers: LinkHandlers;
  pageNames: () => Promise<string[]>;
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
        <h1>📄 {page.title}</h1>
        <span className="status">{status}</span>
      </header>
      <div className="page-notes">
      <JournalEditor
        key={page.id}
        initialContent={page.content}
        onChange={(content, plainText) => {
          pending.current = { content, plainText };
          setStatus("Editing…");
          window.clearTimeout(timer.current);
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
      />
      </div>
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
