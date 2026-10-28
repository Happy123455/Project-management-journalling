import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Extension, ReactRenderer } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";

export interface LinkSuggestOptions {
  /** Names of existing pages and everything linked so far. */
  pageNames: () => Promise<string[]>;
}

interface Option {
  name: string;
  isNew: boolean;
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

interface ListProps {
  items: Option[];
  command: (item: Option) => void;
}
interface ListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const LinkList = forwardRef<ListHandle, ListProps>(function LinkList({ items, command }, ref) {
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
  if (!items.length) return <div className="link-suggest empty">Type a name</div>;
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
          {item.isNew ? <>➕ Create “{item.name}”</> : <>📄 {item.name}</>}
        </button>
      ))}
    </div>
  );
});

/** Typing "[[" suggests page and person names; picking one completes the link. */
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
        items: async ({ query }) => linkOptions(await options.pageNames(), query),
        command: ({ editor, range, props }) => {
          // The "/" Link tile leaves "]]" after the cursor; replace it too.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size));
          const to = after === "]]" ? range.to + 2 : range.to;
          editor.chain().focus().insertContentAt({ from: range.from, to }, `[[${props.name}]] `).run();
        },
        render: () => {
          let component: ReactRenderer<ListHandle, ListProps> | undefined;
          let unmount: (() => void) | undefined;
          return {
            onStart: (props: SuggestionProps<Option, Option>) => {
              component = new ReactRenderer(LinkList, { props, editor: props.editor });
              component.element.classList.add("slash-popup");
              unmount = props.mount(component.element as HTMLElement);
            },
            onUpdate: (props: SuggestionProps<Option, Option>) => component?.updateProps(props),
            // Esc is handled by the suggestion plugin itself.
            onKeyDown: ({ event }: SuggestionKeyDownProps) => component?.ref?.onKeyDown(event) ?? false,
            onExit: () => {
              unmount?.();
              component?.destroy();
            },
          };
        },
      }),
    ];
  },
});
