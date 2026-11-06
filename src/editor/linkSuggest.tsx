import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Extension, ReactRenderer } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { dayOptions, headingsIn, isDayTarget, splitTarget } from "../lib/noteLinks";
import { journalStore } from "./attachments";
import { extractLinks } from "../lib/links";

export interface LinkSuggestOptions {
  /** Names of existing pages and everything linked so far. */
  pageNames: () => Promise<string[]>;
}

interface Option {
  /** What goes between the brackets (or after the #). */
  name: string;
  isNew: boolean;
  /** Shown instead of the name (a day's date, a part's heading). */
  label?: string;
  icon?: string;
}

const MAX_OPTIONS = 6;

/** Matching names, best first; offers to create the typed name when nothing matches it exactly. */
export function linkOptions(names: string[], query: string): Option[] {
  const q = query.trim().toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q));
  const contains = names.filter((n) => !starts.includes(n) && n.toLowerCase().includes(q));
  const options = [...starts, ...contains].slice(0, MAX_OPTIONS).map((name) => ({ name, isNew: false }));
  if (q && !names.some((n) => n.toLowerCase() === q)) options.push({ name: query.trim(), isNew: true });
  return options;
}

/** Days (cached a little: listing them on every letter isn't needed). */
let daysCache: { at: number; days: string[] } | null = null;
async function knownDays(): Promise<string[]> {
  if (daysCache && Date.now() - daysCache.at < 20_000) return daysCache.days;
  const days = (await journalStore()?.listDays().catch(() => [])) ?? [];
  daysCache = { at: Date.now(), days };
  return days;
}

/** The note a link names: a day's page or a named page. */
export async function noteDoc(note: string) {
  const store = journalStore();
  if (!store) return null;
  if (isDayTarget(note)) return (await store.getDay(note).catch(() => null))?.content ?? null;
  return (await store.getPage(note).catch(() => null))?.content ?? null;
}

/**
 * What "[[" suggests: pages and people, days ("today", "nov 3", "2026-11"), and after
 * "Note#" the headings of that note, to link (or with "!" in front, embed) just that part.
 */
export async function noteOptions(names: string[], query: string): Promise<Option[]> {
  const hash = query.indexOf("#");
  if (hash > 0) {
    const { note } = splitTarget(`${query.slice(0, hash)}#x`);
    const typed = query.slice(hash + 1).trim().toLowerCase();
    const heads = headingsIn(await noteDoc(note));
    const hits = heads.filter((h) => h.toLowerCase().includes(typed)).slice(0, MAX_OPTIONS);
    const opts: Option[] = hits.map((h) => ({ name: `${note}#${h}`, label: h, icon: "§", isNew: false }));
    if (typed && !hits.some((h) => h.toLowerCase() === typed)) opts.push({ name: `${note}#${query.slice(hash + 1).trim()}`, label: `“${query.slice(hash + 1).trim()}” (the line starting with it)`, icon: "§", isNew: false });
    return opts;
  }
  const pages = linkOptions(names.filter((n) => !isDayTarget(n)), query);
  const days = dayOptions(await knownDays(), query, undefined, query.trim() ? 4 : 3).map((d) => ({ name: d.day, label: d.label, icon: "📅", isNew: false }));
  // Typing a date (or "today", "yest…"): days first.
  const dayish = /^(\d|to|ye|tom|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(query.trim());
  const isNew = pages.filter((p) => p.isNew);
  const known = pages.filter((p) => !p.isNew);
  return dayish ? [...days, ...known, ...isNew] : [...known, ...days, ...isNew];
}

interface ListProps {
  items: Option[];
  command: (item: Option) => void;
  /** Shown under the list. */
  hint?: string;
  empty?: string;
  /** Nothing to suggest: show nothing (instead of the "Type a name" line). */
  hideEmpty?: boolean;
}
interface ListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const SuggestList = forwardRef<ListHandle, ListProps>(function SuggestList({ items, command, hint, empty, hideEmpty }, ref) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") return setSelected((s) => Math.min(items.length - 1, s + 1)), true;
      if (event.key === "ArrowUp") return setSelected((s) => Math.max(0, s - 1)), true;
      if (event.key === "Enter" || event.key === "Tab") return command(items[selected]), true;
      return false;
    },
  }));
  if (!items.length) return hideEmpty ? null : <div className="link-suggest empty">{empty ?? "Type a name"}</div>;
  return (
    <div className="link-suggest" role="listbox">
      {items.map((item, i) => (
        <button
          key={item.name + item.isNew}
          type="button"
          role="option"
          aria-selected={i === selected}
          className={i === selected ? "selected" : ""}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command(item)}
        >
          {item.isNew ? <>➕ Create “{item.name}”</> : <>{item.icon ?? "📄"} {item.label ?? item.name}</>}
        </button>
      ))}
      {hint && <div className="link-suggest-hint">{hint}</div>}
    </div>
  );
});

/** The pop-up for a suggestion plugin. */
function popup(extra: Partial<ListProps>) {
  return () => {
    let component: ReactRenderer<ListHandle, ListProps> | undefined;
    let unmount: (() => void) | undefined;
    return {
      onStart: (props: SuggestionProps<Option, Option>) => {
        component = new ReactRenderer(SuggestList, { props: { ...props, ...extra }, editor: props.editor });
        component.element.classList.add("slash-popup");
        unmount = props.mount(component.element as HTMLElement);
      },
      onUpdate: (props: SuggestionProps<Option, Option>) => component?.updateProps({ ...props, ...extra }),
      // Esc is handled by the suggestion plugin itself.
      onKeyDown: ({ event }: SuggestionKeyDownProps) => component?.ref?.onKeyDown(event) ?? false,
      onExit: () => {
        unmount?.();
        component?.destroy();
      },
    };
  };
}

/** Every #tag used so far, most used first (cached a little; a save or sync starts it over). */
let tagCache: { at: number; tags: string[] } | null = null;
if (typeof window !== "undefined")
  for (const ev of ["journal:saved", "journal:synced"])
    window.addEventListener(ev, () => {
      tagCache = null;
      daysCache = null;
    });
export async function knownTags(): Promise<string[]> {
  if (tagCache && Date.now() - tagCache.at < 20_000) return tagCache.tags;
  const links = (await journalStore()?.graphLinks().catch(() => [])) ?? [];
  const counts = new Map<string, { name: string; n: number }>();
  for (const l of links) {
    if (l.kind !== "tag") continue;
    const k = l.target.toLowerCase();
    const c = counts.get(k) ?? { name: l.target, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  const tags = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((c) => c.name);
  tagCache = { at: Date.now(), tags };
  return tags;
}

/** Tags matching what's typed after "#": starting with it first, then containing it. */
export function tagOptions(tags: string[], query: string, max = 8): string[] {
  const q = query.toLowerCase();
  const starts = tags.filter((t) => t.toLowerCase().startsWith(q) && t.toLowerCase() !== q);
  const contains = tags.filter((t) => !starts.includes(t) && t.toLowerCase().includes(q) && t.toLowerCase() !== q);
  return [...starts, ...contains].slice(0, max);
}

/** Typing "[[" suggests pages, people and days (and "#part" of one); picking one completes the link. */
export const LinkSuggest = Extension.create<LinkSuggestOptions>({
  name: "linkSuggest",
  addOptions() {
    return { pageNames: async () => [] };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<Option, Option>({
        editor: this.editor,
        pluginKey: new PluginKey("linkSuggest"),
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        // Only while the link is still open: "[[Ravi]] and more" is already finished.
        allow: ({ state, range }) =>
          state.doc.resolve(range.from).parent.type.name !== "codeBlock" &&
          !state.doc.textBetween(range.from, range.to).slice(2).includes("]"),
        items: async ({ query }) => noteOptions(await options.pageNames(), query),
        command: ({ editor, range, props }) => {
          // The "/" Link tile leaves "]]" after the cursor; replace it too.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size));
          const to = after === "]]" ? range.to + 2 : range.to;
          editor.chain().focus().insertContentAt({ from: range.from, to }, `[[${props.name}]] `).run();
        },
        render: popup({ hint: "Type # after a name for one part of it · ! before [[ shows it here" }),
      }),
      // "#": the tags already in the journal.
      Suggestion<Option, Option>({
        editor: this.editor,
        pluginKey: new PluginKey("tagSuggest"),
        char: "#",
        allowSpaces: false,
        allowedPrefixes: [" ", " ", "(", "\n"],
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name === "codeBlock" || $from.parent.type.name === "heading") return false;
          // "# " at the start of a line makes a heading; "[[Note#" is a part of a link.
          const before = state.doc.textBetween($from.start(), range.from);
          return !/\[\[[^\]]*$/.test(before);
        },
        items: async ({ query, editor }) => {
          // "#2" or "#1st" are numbers, not tags; a space ends the tag.
          if (/^\d+$/.test(query)) return [];
          // This note's own tags count too (they're saved a moment after typing).
          const here = extractLinks(editor.getText({ blockSeparator: "\n" })).tags;
          const all = [...new Map([...(await knownTags()), ...here].map((t) => [t.toLowerCase(), t])).values()];
          return tagOptions(all, query).map((t) => ({ name: t, label: `#${t}`, icon: "🏷", isNew: false }));
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().insertContentAt(range, `#${props.name} `).run();
        },
        render: popup({ hideEmpty: true }),
      }),
    ];
  },
});
