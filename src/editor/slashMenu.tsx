import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Extension, ReactRenderer, type Editor, type Range } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { filterSlashItems, type SlashId, type SlashItem } from "../lib/slashItems";
import { formatTimestamp } from "../lib/timestamp";
import { openCapture, pickFiles } from "./attachments";
import { openVoiceRecorder } from "./VoiceRecorder";
import { openMemeKit } from "./MemeKit";
import { saveToInspiration } from "./inspiration";

/** Where the editor is (the page title), for "saved from" notes. */
const placeLabel = () => document.querySelector(".page-header h1")?.textContent?.trim() ?? "";

export interface SlashMenuOptions {
  /** Called by the Reminder tile; the app opens a day picker for a future page. */
  onReminder: () => void;
}

const SLASH_KEY = new PluginKey("slashMenu");


function run(id: SlashId, editor: Editor, range: Range, options: SlashMenuOptions) {
  const chain = editor.chain().focus().deleteRange(range);
  switch (id) {
    case "heading": return chain.toggleHeading({ level: 2 }).run();
    case "task": return chain.toggleTaskList().run();
    case "bullet": return chain.toggleBulletList().run();
    case "numbered": return chain.toggleOrderedList().run();
    case "quote": return chain.toggleBlockquote().run();
    case "code": return chain.toggleCodeBlock().run();
    case "divider": return chain.setHorizontalRule().run();
    case "timestamp": return chain.insertContent(formatTimestamp(new Date()) + " ").run();
    case "tag": return chain.insertContent("#").run();
    case "link": {
      chain.insertContent("[[]]").run();
      const at = editor.state.selection.from - 2;
      return editor.chain().setTextSelection(at).run();
    }
    case "reminder":
      chain.run();
      options.onReminder();
      return true;
    case "attach":
      chain.run();
      pickFiles(editor, "*/*"); // one "any file" filter: mixed lists confuse some Android pickers
      return true;
    case "capture":
      chain.run();
      openCapture(editor);
      return true;
    case "voice":
      chain.run();
      openVoiceRecorder(editor);
      return true;
    case "meme":
      chain.run();
      openMemeKit(editor, "memes");
      return true;
    case "sound":
      chain.run();
      openMemeKit(editor, "sounds");
      return true;
    case "inspiration":
      chain.run();
      void saveToInspiration(editor, placeLabel());
      return true;
    case "prompt":
      return chain.insertContent({ type: "promptBlock" }).run();
    case "project":
      chain.run();
      window.dispatchEvent(new CustomEvent("journal:new-project", { detail: { editor } }));
      return true;
    case "log":
      // A list whose items each start with the time; Enter adds the next timestamped entry.
      return chain.toggleBulletList().insertContent(formatTimestamp(new Date()) + " ").run();
  }
}

interface MenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  /** What's been typed after "/" (it filters the tiles). */
  query?: string;
}

export interface MenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** Grid of big tiles under the line being typed. */
const SlashGrid = forwardRef<MenuHandle, MenuProps>(function SlashGrid({ items, command, query = "" }, ref) {
  const [selected, setSelected] = useState(0);
  const columns = 4;
  const grid = useRef<HTMLDivElement>(null);
  // Keep the chosen tile in view, and the whole panel inside the screen.
  useLayoutEffect(() => {
    grid.current?.querySelector(".slash-tile.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useLayoutEffect(() => {
    const popup = grid.current?.closest<HTMLElement>(".slash-popup");
    if (!popup) return;
    // After the popup has been placed under the line: nudge it back inside the screen's sides.
    const frame = requestAnimationFrame(() => {
      popup.style.translate = "";
      const r = popup.getBoundingClientRect();
      const width = window.visualViewport?.width ?? window.innerWidth;
      const dx = r.right > width - 8 ? width - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
      if (dx) popup.style.translate = `${dx}px 0`;
    });
    return () => cancelAnimationFrame(frame);
  });
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (!items.length) return false;
      const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
      if (move !== undefined) {
        setSelected((s) => Math.min(items.length - 1, Math.max(0, s + move)));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        command(items[selected]);
        return true;
      }
      return false;
    },
  }));

  if (!items.length) return <div className="slash-menu empty">No block matches “{query}”</div>;
  return (
    <div ref={grid} className="slash-menu" role="listbox" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      <div className="slash-filter" aria-live="polite">
        🔍 /{query || <span className="hint">type to filter</span>}
      </div>
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === selected}
          className={i === selected ? "slash-tile selected" : "slash-tile"}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
        >
          <span className="slash-icon">{item.icon}</span>
          <span className="slash-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
});

/** Typing "/" at the start of a line or after a space opens the tile grid; typing more filters it. */
export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: "slashMenu",
  addOptions() {
    return { onReminder: () => {} };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: SLASH_KEY,
        char: "/",
        allowedPrefixes: [" "],
        // "/" inside code is just a slash.
        allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name !== "codeBlock",
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => run(props.id, editor, range, options),
        render: () => {
          let component: ReactRenderer<MenuHandle, MenuProps> | undefined;
          let unmount: (() => void) | undefined;
          return {
            onStart: (props: SuggestionProps<SlashItem, SlashItem>) => {
              component = new ReactRenderer(SlashGrid, { props, editor: props.editor });
              component.element.classList.add("slash-popup");
              unmount = props.mount(component.element as HTMLElement);
            },
            onUpdate: (props: SuggestionProps<SlashItem, SlashItem>) => component?.updateProps(props),
            onKeyDown: ({ event, view, range }: SuggestionKeyDownProps) => {
              // Esc cancels the command: remove the "/…" typed so far, which also closes the menu.
              // (Leaving it in place makes the plugin swallow the next "/" typed in that spot.)
              if (event.key === "Escape") {
                view.dispatch(view.state.tr.delete(range.from, range.to));
                return true;
              }
              return component?.ref?.onKeyDown(event) ?? false;
            },
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
