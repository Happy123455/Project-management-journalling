import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { showToast } from "../lib/toast";
import { plainText } from "../lib/plainText";
import { DeadlineBar } from "./deadlineBar";
import { applyTyping, REMOTE, sendTyping, TYPING_EVENT, type TypingMsg } from "../sync/liveTyping";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { cleanPastedHTML } from "../lib/smartPaste";
import { LinkHighlight } from "./linkHighlight";
import { hasEmbeds } from "../lib/embeds";
import { AttachmentFile, AttachmentImage, AttachmentMedia, insertFiles, mediaLeafText, pasteEmbeds, upgradeOldMedia } from "./attachments";
import { codeBlockFromSelection, JournalCodeBlock } from "./codeBlock";
import { BlockInfoExtension } from "./blockInfo";
import { BlockHandle } from "./BlockHandle";
import { blockIndexAt, blockPos, Blocks, foldRange, indentBlock, moveBlock } from "./blocks";
import { AutoPairs } from "./autoPairs";
import { MathAuto } from "./mathAuto";
import { MathInline } from "./mathInline";
import { BlockInfoPanel } from "./BlockInfoPanel";
import { readAloud } from "../lib/readAloud";
import { isLoneUrl, LinkCard } from "./linkCard";
import { PromptBlock } from "./promptBlock";
import { MathBlock } from "./mathBlock";
import { YoutubeEmbed, youtubeEmbedFrom } from "./youtubeEmbed";
import { FindHighlight, findKey } from "./findHighlight";
import { LogBlock } from "./logBlock";
import { KeyboardBar, useTouchDevice } from "./KeyboardBar";
import { HotCaret } from "./HotCaret";
import { LinkSuggest } from "./linkSuggest";
import { insertLogOrTime, SlashMenu } from "./slashMenu";
import { openOutline, setViewMode, useViewMode, type ViewMode } from "./viewMode";
import { SourceEditor } from "./SourceEditor";
import { openVoiceRecorder } from "./VoiceRecorder";
import { dayKey } from "../lib/timestamp";
import { jumpTo, OutlinePanel } from "./Outline";
import { TimeRail, useTimeRail } from "./TimeRail";
import { registerOpenNote } from "./noteEdit";
import { docToMarkdown, docToSource, sourceMemory, sourceToDoc, type SourceMemory } from "../lib/source";
import { docText } from "../lib/words";
import { SmartPaste } from "./SmartPaste";
import { Timestamp } from "./timestamp";
import { TimestampChip } from "./timestampChip";
import { EditStamp } from "./editStamp";
import { BlockBorn } from "./blockBorn";
import { LID_INIT, LineIds } from "./lineIds";
import { GifIcon, insertQuickLog, openQuickLogSetup, useQuickLogs } from "../projects/quickLog";

interface Props {
  initialContent: JSONContent | null;
  /** `actor` is set when the change came from an AI (the transaction's "aiActor" meta). */
  /** Live typing over Wi-Fi with the other device (see sync/liveTyping.ts), e.g. "day:2026-11-01". */
  liveKey?: string;
  onChange: (content: JSONContent, plainText: string, actor?: string) => void;
  onReady?: (plainText: string) => void;
  /** The "/" menu's Reminder tile: let the user pick a future day to write on. */
  onReminder?: () => void;
  onOpenLink?: (title: string) => void;
  onOpenTag?: (tag: string) => void;
  /** Names for [[ autocomplete. */
  pageNames?: () => Promise<string[]>;
  autofocus?: boolean;
  /** Search words to highlight in this note, and which match to scroll to. */
  find?: { terms: string[]; index: number } | null;
  /** How many matches the note has for `find`. */
  onFindCount?: (count: number) => void;
  /** A day before today: lines written in it get an edit stamp. */
  pastDay?: boolean;
}

interface Tool {
  key: string;
  label: React.ReactNode;
  title: string;
  run: () => void;
  active?: boolean;
  disabled?: boolean;
}

/** Edits typed but not yet handed to `onChange` (it runs once typing pauses, not per letter). */
const pendingEmits = new Set<() => void>();
/** Hands every open editor's latest text to its `onChange` now (before saving or switching day). */
/** True while some open editor has letters not yet handed over (typed in the last moment). */
export const hasPendingEdits = () => pendingEmits.size > 0;
/** When this device last changed a note itself; the other device's typing waits a moment after it. */
let lastLocalEdit = 0;
const QUIET_MS = 3000;
export function flushPendingEdits() {
  for (const emit of [...pendingEmits]) emit();
}
/** Serialising the whole note per letter made typing stall on long days; wait for a short pause. */
const EMIT_DELAY_MS = 250;

const TOOLS_KEY = "dynamic-journal.toolbar";
/** Tools the Mac's toolbar leaves out (the mode pill and the keyboard cover them there). */
const PHONE_ONLY = new Set(["hidekb", "lineup", "linedown", "outline", "source", "reading", "left", "right", "selectline", "selectall", "copyline", "paste", "date", "voice", "clearfmt"]);
/** The phone bar's tool order and hidden tools, kept on this device. */
export interface ToolLayout {
  order: string[];
  hidden: string[];
  /** Rows of tools shown at once above the phone keyboard (swipe up for more). */
  rows?: 1 | 2;
  /** "strip": one row that scrolls sideways instead of rows that scroll up. */
  style?: "rows" | "strip";
  /** Bigger buttons. */
  big?: boolean;
  /** The newer tools (EXTRA_TOOLS) have been offered: they start hidden, ticked on in Arrange tools. */
  extras?: boolean;
}
/** Tools added later: hidden until picked in Arrange tools, so nobody's bar suddenly fills up. */
const EXTRA_TOOLS = ["left", "right", "selectline", "copyline", "paste", "date", "voice", "clearfmt", "selectall"];
export const TOOL_LAYOUT_EVENT = "journal:toolbar-layout";
export function loadToolLayout(): ToolLayout {
  try {
    const v = JSON.parse(localStorage.getItem(TOOLS_KEY) ?? "{}");
    const hidden: string[] = Array.isArray(v.hidden) ? v.hidden : [];
    return {
      order: Array.isArray(v.order) ? v.order : [],
      hidden: v.extras ? hidden : [...hidden, ...EXTRA_TOOLS.filter((k) => !hidden.includes(k))],
      extras: true,
      rows: v.rows === 2 ? 2 : 1,
      style: v.style === "strip" ? "strip" : "rows",
      big: !!v.big,
    };
  } catch {
    return { order: [], hidden: [...EXTRA_TOOLS], rows: 1, style: "rows", extras: true };
  }
}
function saveToolLayout(layout: ToolLayout) {
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(layout));
  } catch {
    // Only a convenience.
  }
  window.dispatchEvent(new Event(TOOL_LAYOUT_EVENT));
}
/** Tools in the saved order (new tools go at the end), without hidden ones unless asked. */
export function arrangeTools<T extends { key: string }>(tools: T[], layout: ToolLayout, withHidden = false): T[] {
  const rank = (k: string) => {
    const i = layout.order.indexOf(k);
    return i < 0 ? layout.order.length + tools.findIndex((t) => t.key === k) : i;
  };
  return [...tools].sort((a, b) => rank(a.key) - rank(b.key)).filter((t) => withHidden || !layout.hidden.includes(t.key));
}

/** Unfolds every folded block that hides `pos` (its folded parents, and a folded code block or prompt it's in). */
export function unfoldAround(editor: Editor, pos: number) {
  const { doc } = editor.state;
  const index = blockIndexAt(doc, pos);
  const tr = editor.state.tr;
  for (let i = 0; i <= index; i++) {
    const node = doc.child(i);
    if (!node.attrs.collapsed) continue;
    if (i === index ? node.type.name === "codeBlock" || node.type.name === "promptBlock" : foldRange(doc, i).end > index) {
      tr.setNodeMarkup(blockPos(doc, i), undefined, { ...node.attrs, collapsed: false });
    }
  }
  if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
}

/** A short haptic on the phone (MainActivity's glass ticks), or a tiny vibration elsewhere. */
function haptic(kind: "tap" | "tick" | "press" | "edge", strength: number) {
  try {
    if (window.JournalHaptics) window.JournalHaptics.play(kind, strength);
    else navigator.vibrate?.(kind === "press" ? 12 : 6);
  } catch {
    // No vibration here.
  }
}

/** Formatting buttons, shared by the top toolbar (Mac) and the bar above the phone keyboard. */
function ToolbarButtons({ editor, onInfo, phone }: { editor: Editor; onInfo: () => void; phone?: boolean }) {
  const [layout, setLayout] = useState(loadToolLayout);
  // Edit mode (phone): the bar's tools jiggle, lifted, and are dragged into a new order.
  const [jiggle, setJiggle] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const drag = useRef<{ key: string; id: number } | null>(null);
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Arrange tools (its own window, kept open when the keyboard goes) changes the layout: follow it.
  useEffect(() => {
    const on = () => setLayout(loadToolLayout());
    window.addEventListener(TOOL_LAYOUT_EVENT, on);
    return () => window.removeEventListener(TOOL_LAYOUT_EVENT, on);
  }, []);
  const quick = useQuickLogs();
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bullet: e.isActive("bulletList"),
      task: e.isActive("taskList"),
      ordered: e.isActive("orderedList"),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      highlight: e.isActive("highlight"),
      code: e.isActive("codeBlock"),
      strike: e.isActive("strike"),
      inlineCode: e.isActive("code"),
      quote: e.isActive("blockquote"),
      heading: e.isActive("heading") ? (e.getAttributes("heading").level as number) : 0,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const block = (command: (i: number) => import("@tiptap/pm/state").Command) => () => {
    command(blockIndexAt(editor.state.doc, editor.state.selection.from))(editor.state, editor.view.dispatch);
    editor.commands.focus();
  };

  const tools: Tool[] = [
    { key: "undo", label: "↶", title: "Undo (Cmd/Ctrl+Z)", disabled: !active.canUndo, run: () => editor.chain().focus().undo().run() },
    { key: "redo", label: "↷", title: "Redo (Cmd/Ctrl+Shift+Z)", disabled: !active.canRedo, run: () => editor.chain().focus().redo().run() },
    { key: "slash", label: "/", title: "Blocks menu", run: () => editor.chain().focus().insertContent(editor.state.selection.$from.parentOffset ? " /" : "/").run() },
    { key: "bullet", label: "•", title: "Bullet list", active: active.bullet, run: () => editor.chain().focus().toggleBulletList().run() },
    { key: "task", label: "☑", title: "Task list", active: active.task, run: () => editor.chain().focus().toggleTaskList().run() },
    { key: "ordered", label: "1.", title: "Numbered list", active: active.ordered, run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: "outdent", label: "⇤", title: "Un-nest (Shift+Tab)", run: () => (editor.isActive("listItem") || editor.isActive("taskItem") ? editor.chain().focus().liftListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run() : block((i) => indentBlock(i, -1))()) },
    { key: "indent", label: "⇥", title: "Nest (Tab)", run: () => (editor.isActive("listItem") || editor.isActive("taskItem") ? editor.chain().focus().sinkListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run() : block((i) => indentBlock(i, 1))()) },
    { key: "bold", label: "B", title: "Bold (Cmd/Ctrl+B)", active: active.bold, run: () => editor.chain().focus().toggleBold().run() },
    { key: "italic", label: "I", title: "Italic (Cmd/Ctrl+I)", active: active.italic, run: () => editor.chain().focus().toggleItalic().run() },
    { key: "highlight", label: "H", title: "Highlight (Cmd/Ctrl+Shift+H)", active: active.highlight, run: () => editor.chain().focus().toggleHighlight().run() },
    { key: "code", label: "</>", title: "Code block (or type ``` and Enter)", active: active.code, run: () => codeBlockFromSelection(editor) },
    { key: "timestamp", label: "🕒", title: "Log / time: on an empty line starts a timed log, in text adds the time (Cmd/Ctrl+Shift+T)", run: () => insertLogOrTime(editor) },
    { key: "info", label: "ⓘ", title: "Block info", run: onInfo },
    {
      key: "heading",
      label: active.heading ? `H${active.heading}` : "H",
      title: "Heading (tap again for a smaller one, then back to text)",
      active: !!active.heading,
      run: () => {
        const next = active.heading >= 3 ? 0 : active.heading + 1;
        const chain = editor.chain().focus();
        if (next) chain.setHeading({ level: next as 1 | 2 | 3 }).run();
        else chain.setParagraph().run();
      },
    },
    { key: "strike", label: "S", title: "Strikethrough", active: active.strike, run: () => editor.chain().focus().toggleStrike().run() },
    { key: "inlinecode", label: "`", title: "Inline code", active: active.inlineCode, run: () => editor.chain().focus().toggleCode().run() },
    { key: "quote", label: "❝", title: "Quote", active: active.quote, run: () => editor.chain().focus().toggleBlockquote().run() },
    {
      key: "wikilink",
      label: "[[ ]]",
      title: "Link a page",
      run: () => {
        const { from, to, empty } = editor.state.selection;
        const picked = editor.state.doc.textBetween(from, to, " ");
        editor.chain().focus().insertContent(`[[${picked}]]`).run();
        if (empty) editor.commands.setTextSelection(editor.state.selection.from - 2);
      },
    },
    { key: "tag", label: "#", title: "Tag", run: () => editor.chain().focus().insertContent("#").run() },
    { key: "divider", label: "—", title: "Divider", run: () => editor.chain().focus().setHorizontalRule().run() },
    { key: "lineup", label: "⤒", title: "Move this block up", run: block((i) => moveBlock(i, -1)) },
    { key: "linedown", label: "⤓", title: "Move this block down", run: block((i) => moveBlock(i, 1)) },
    { key: "outline", label: "☰", title: "Outline", run: openOutline },
    { key: "source", label: "</>", title: "Source mode (plain text)", run: () => setViewMode("source") },
    { key: "reading", label: "📖", title: "Reading mode", run: () => setViewMode("reading") },
    {
      key: "hidekb",
      label: "⌄",
      title: "Hide the keyboard",
      run: () => {
        editor.commands.blur();
        window.JournalShare?.hideKeyboard?.();
      },
    },
    { key: "left", label: "◀", title: "Cursor left", run: () => editor.chain().focus().setTextSelection(Math.max(1, editor.state.selection.from - 1)).run() },
    { key: "right", label: "▶", title: "Cursor right", run: () => editor.chain().focus().setTextSelection(Math.min(editor.state.doc.content.size - 1, editor.state.selection.to + 1)).run() },
    {
      key: "selectline",
      label: "▭",
      title: "Select this line",
      run: () => {
        const { $from } = editor.state.selection;
        editor.chain().focus().setTextSelection({ from: $from.start(), to: $from.end() }).run();
      },
    },
    { key: "selectall", label: "⬚", title: "Select all", run: () => editor.chain().focus().selectAll().run() },
    {
      key: "copyline",
      label: "⧉",
      title: "Copy this line (or the selection)",
      run: () => {
        const { from, to, empty, $from } = editor.state.selection;
        const text = empty ? $from.parent.textContent : editor.state.doc.textBetween(from, to, "\n", " ");
        void navigator.clipboard?.writeText(text).then(() => showToast("Copied"), () => showToast("Couldn't copy", "error"));
      },
    },
    {
      key: "paste",
      label: "📋",
      title: "Paste",
      run: () => {
        void navigator.clipboard?.readText().then((t) => t && editor.chain().focus().insertContent(t).run(), () => showToast("Couldn't read the clipboard", "error"));
      },
    },
    { key: "date", label: "📅", title: "Link today's date", run: () => editor.chain().focus().insertContent(`[[${dayKey(new Date())}]] `).run() },
    { key: "voice", label: "🎙", title: "Voice note", run: () => openVoiceRecorder(editor, "voice") },
    { key: "clearfmt", label: "T̸", title: "Clear formatting", run: () => editor.chain().focus().unsetAllMarks().clearNodes().run() },
    {
      key: "read",
      label: "🔊",
      title: "Read aloud (the selection, or this paragraph)",
      run: () => {
        const { from, to, empty, $from } = editor.state.selection;
        readAloud(empty ? $from.parent.textContent || editor.getText({ blockSeparator: "\n" }) : editor.state.doc.textBetween(from, to, "\n", " "));
      },
    },
  ];
  // Quick log: one tap adds a project's box (its icon picked by hand or by the Mac's AI). They come first.
  const quickTools: Tool[] = quick.map((q) => ({ key: `ql:${q.id}`, label: q.iconFile ? <GifIcon fileId={q.iconFile} /> : q.icon ?? "⚡", title: `Quick log: ${q.title}`, run: () => insertQuickLog(editor, q.title) }));
  const setupTool: Tool = { key: "quicklog", label: "⚡", title: "Quick log buttons", run: openQuickLogSetup };
  // Phone: quick-log buttons are tools like the others (first by default; dragged, hidden and
  // ordered the same way in edit mode and Arrange tools), and ⚡ setup stays put instead of
  // appearing and vanishing as the list loads.
  const allTools = phone ? [...quickTools, ...tools, setupTool] : [...tools, setupTool];
  toolCatalog = allTools.map((t) => ({ key: t.key, label: t.label, title: t.title }));
  const arranged = arrangeTools(allTools, layout);
  const startJiggle = () => {
    haptic("press", 0.7);
    setJiggle(true);
    // The bar opens to every row; start at the first one.
    window.requestAnimationFrame(() => document.querySelector(".keyboard-bar")?.scrollTo({ top: 0 }));
  };
  const stopJiggle = () => {
    haptic("edge", 0.6);
    setJiggle(false);
    setDragKey(null);
    drag.current = null;
  };
  const shown: Tool[] = phone
    ? jiggle
      ? [...arranged, { key: "jiggle-more", label: "⋯", title: "Show or hide tools, layout", run: openArrangeTools }, { key: "jiggle-done", label: "✓ Done", title: "Done arranging", run: stopJiggle }]
      : [...arranged, { key: "arrange", label: "⚙︎", title: "Arrange tools (or hold any tool)", run: startJiggle }]
    : [...quickTools, ...allTools.filter((t) => !PHONE_ONLY.has(t.key))];
  const movable = (k: string) => arranged.some((t) => t.key === k);
  // Dragging in edit mode: the tool under the finger makes room (the order changes as it moves).
  const onDragMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // By each tool's box (not elementFromPoint): the bar is moved and scrolled, and the lifted
    // tool under the finger would otherwise hide what it's over.
    const bar = (e.currentTarget as HTMLElement).parentElement;
    let over: string | null = null;
    for (const el of bar ? Array.from(bar.querySelectorAll<HTMLElement>("[data-tool]")) : []) {
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) over = el.getAttribute("data-tool");
    }
    if (!over || over === d.key || !movable(over)) return;
    const keys = arrangeTools(allTools, layoutRef.current, true).map((t) => t.key);
    const from = keys.indexOf(d.key);
    const to = keys.indexOf(over);
    if (from < 0 || to < 0) return;
    keys.splice(from, 1);
    keys.splice(to, 0, d.key);
    const next = { ...layoutRef.current, order: keys };
    layoutRef.current = next;
    setLayout(next);
    haptic("tick", 0.5);
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    setDragKey(null);
    saveToolLayout(layoutRef.current);
    haptic("edge", 0.8);
  };

  return (
    <>
      {shown.map((b, i) => {
        const canDrag = jiggle && movable(b.key);
        return (
          <button
            key={b.key}
            type="button"
            title={b.title}
            aria-label={b.title}
            aria-pressed={!jiggle && "active" in b ? b.active : undefined}
            disabled={!jiggle && "disabled" in b ? b.disabled : false}
            data-tool={canDrag ? b.key : undefined}
            className={`tool tool-${b.key}${!jiggle && "active" in b && b.active ? " active" : ""}${canDrag ? " jiggle" : ""}${dragKey === b.key ? " lifted" : ""}`}
            style={canDrag ? ({ "--jiggle-delay": `${-((i * 97) % 300)}ms` } as React.CSSProperties) : undefined}
            // Keep the editor focused so the phone keyboard stays open.
            onPointerDown={(e) => {
              e.preventDefault();
              if (canDrag) {
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                drag.current = { key: b.key, id: e.pointerId };
                setDragKey(b.key);
                haptic("press", 0.6);
                return;
              }
              // Phone: holding any tool starts edit mode, like a home screen.
              if (phone && !jiggle && e.pointerType === "touch") {
                const h = { timer: 0, fired: false };
                h.timer = window.setTimeout(() => ((h.fired = true), startJiggle()), 550);
                hold.current = h;
              }
            }}
            onPointerMove={canDrag ? onDragMove : (e) => hold.current && (Math.abs(e.movementX) + Math.abs(e.movementY) > 8) && window.clearTimeout(hold.current.timer)}
            onPointerUp={canDrag ? onDragEnd : () => hold.current && window.clearTimeout(hold.current.timer)}
            onPointerCancel={canDrag ? onDragEnd : () => hold.current && window.clearTimeout(hold.current.timer)}
            onMouseDown={(e) => e.preventDefault()}
            onContextMenu={(e) => phone && e.preventDefault()}
            onClick={() => {
              if (hold.current?.fired) return void (hold.current = null);
              hold.current = null;
              if (canDrag) return;
              b.run();
            }}
          >
            {b.label}
          </button>
        );
      })}
    </>
  );
}


/** What the bar offers, for Arrange tools (kept by the bar each time it draws). */
let toolCatalog: { key: string; label: React.ReactNode; title: string }[] = [];
const ARRANGE_EVENT = "journal:arrange-tools";
const openArrangeTools = () => window.dispatchEvent(new Event(ARRANGE_EVENT));

/**
 * Arrange tools: tick tools on or off and move them with ↑ ↓. It lives outside the keyboard bar, so it
 * stays open (and its arrows keep working) when the note loses focus and the bar goes away.
 */
function ArrangeToolsHost() {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState(loadToolLayout);
  useEffect(() => {
    const onOpen = () => {
      setLayout(loadToolLayout());
      setOpen(true);
    };
    const onLayout = () => setLayout(loadToolLayout());
    window.addEventListener(ARRANGE_EVENT, onOpen);
    window.addEventListener(TOOL_LAYOUT_EVENT, onLayout);
    return () => {
      window.removeEventListener(ARRANGE_EVENT, onOpen);
      window.removeEventListener(TOOL_LAYOUT_EVENT, onLayout);
    };
  }, []);
  const update = (next: ToolLayout) => {
    setLayout(next);
    saveToolLayout(next);
  };
  if (!open) return null;
  return createPortal(
        <div className="arrange-tools" role="dialog" aria-label="Arrange tools" onPointerDown={(e) => {
          e.stopPropagation();
          // Keep the note focused (the keyboard and its bar stay) unless a box or menu is being used.
          if (!(e.target as HTMLElement).closest("select, input")) e.preventDefault();
        }}>
          <div className="arrange-head">
            <strong>Arrange tools</strong>
            <button type="button" onClick={() => update({ order: [], hidden: [...EXTRA_TOOLS], rows: 1, style: "rows", extras: true })}>Reset</button>
            <button type="button" onClick={() => setOpen(false)}>Done</button>
          </div>
          <div className="arrange-layout">
            <label>
              Layout
              <select value={`${layout.style ?? "rows"}-${layout.rows ?? 1}`} onChange={(e) => {
                const [style, rows] = e.target.value.split("-");
                update({ ...layout, style: style as "rows" | "strip", rows: Number(rows) as 1 | 2 });
              }}>
                <option value="rows-1">1 row, swipe up for more</option>
                <option value="rows-2">2 rows, swipe up for more</option>
                <option value="strip-1">1 row, swipe sideways</option>
              </select>
            </label>
            <label className="arrange-big">
              <input type="checkbox" checked={!!layout.big} onChange={(e) => update({ ...layout, big: e.target.checked })} /> Bigger buttons
            </label>
            <p className="hint">Tick the tools you want, and move them with ↑ ↓. Quick-log buttons move like any other tool.</p>
          </div>
          <ul>
            {arrangeTools(toolCatalog, layout, true).map((t, i, all) => {
              const keys = all.map((x) => x.key);
              const swap = (j: number) => {
                const next = [...keys];
                [next[i], next[j]] = [next[j], next[i]];
                update({ ...layout, order: next });
              };
              const hidden = layout.hidden.includes(t.key);
              return (
                <li key={t.key} className={hidden ? "hidden-tool" : ""}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!hidden}
                      onChange={() => update({ ...layout, hidden: hidden ? layout.hidden.filter((k) => k !== t.key) : [...layout.hidden, t.key] })}
                    />
                    <span className="arrange-icon">{t.label}</span>
                    {t.title.replace(/ \(.*\)$/, "")}
                  </label>
                  <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => swap(i - 1)}>↑</button>
                  <button type="button" aria-label="Move down" disabled={i === all.length - 1} onClick={() => swap(i + 1)}>↓</button>
                </li>
              );
            })}
          </ul>
        </div>,
    document.body,
  );
}

const MODES: { mode: ViewMode; icon: string; label: string }[] = [
  { mode: "live", icon: "✎", label: "Live" },
  { mode: "source", icon: "</>", label: "Source" },
  { mode: "reading", icon: "📖", label: "Reading" },
];

/** Live / Source / Reading, and the outline: always in reach above the note. */
function ModePill({ mode, editor }: { mode: ViewMode; editor: Editor | null }) {
  const [copied, setCopied] = useState<"" | "plain" | "md">("");
  // The whole note in one tap, as plain text or as Markdown (each block's ⧉ still copies just that block).
  const copyAll = async (as: "plain" | "md") => {
    if (!editor) return;
    const { copyText } = await import("./codeBlock");
    const json = editor.getJSON();
    const text = as === "md" ? docToMarkdown(json) : plainText((json.content ?? []) as JSONContent[]);
    if (!text.trim()) return showToast("Nothing to copy yet");
    try {
      await copyText(text);
      setCopied(as);
      window.setTimeout(() => setCopied(""), 1400);
    } catch (e) {
      showToast(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };
  return (
    <div className="editor-modes" role="toolbar" aria-label="How the note is shown" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      {MODES.map((m) => (
        <button key={m.mode} type="button" className={mode === m.mode ? "active" : ""} aria-pressed={mode === m.mode} title={`${m.label} mode`} onClick={() => setViewMode(m.mode)}>
          <span aria-hidden>{m.icon}</span> <span className="mode-label">{m.label}</span>
        </button>
      ))}
      <button type="button" title="Outline" onClick={openOutline}>
        <span aria-hidden>☰</span> <span className="mode-label">Outline</span>
      </button>
      <button type="button" title="Copy the whole note as plain text" className={copied === "plain" ? "copied" : ""} onClick={() => void copyAll("plain")}>
        <span aria-hidden>{copied === "plain" ? "✓" : "⧉"}</span> <span className="mode-label">{copied === "plain" ? "Copied" : "Copy all"}</span>
      </button>
      <button type="button" title="Copy the whole note as Markdown (keeps **bold**, `code` and [[links]])" className={copied === "md" ? "copied" : ""} onClick={() => void copyAll("md")}>
        <span aria-hidden>{copied === "md" ? "✓" : "M↓"}</span> <span className="mode-label">{copied === "md" ? "Copied" : "Markdown"}</span>
      </button>
    </div>
  );
}

export function JournalEditor({
  initialContent, onChange, onReady, onReminder, onOpenLink, onOpenTag, pageNames, autofocus = true, find, onFindCount, pastDay, liveKey,
}: Props) {
  const liveKeyRef = useRef(liveKey);
  liveKeyRef.current = liveKey;
  const pastDayRef = useRef(pastDay);
  pastDayRef.current = pastDay;
  const touch = useTouchDevice();
  const [infoOpen, setInfoOpen] = useState(false);
  const mode = useViewMode();
  const [toolLayout, setToolLayout] = useState(loadToolLayout);
  useEffect(() => {
    const on = () => setToolLayout(loadToolLayout());
    window.addEventListener(TOOL_LAYOUT_EVENT, on);
    return () => window.removeEventListener(TOOL_LAYOUT_EVENT, on);
  }, []);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [outlineOpen, setOutlineOpen] = useState(false);
  const timeRail = useTimeRail();
  /** Source mode: the text shown, and what the note had (media details the text doesn't show). */
  const source = useRef<{ text: string; start: string; mem: SourceMemory } | null>(null);
  const sourceTimer = useRef<number | undefined>(undefined);
  const editorRef = useRef<Editor | null>(null);
  const emitTimer = useRef<number | undefined>(undefined);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const emit = useRef(() => {
    window.clearTimeout(emitTimer.current);
    pendingEmits.delete(emit.current);
    const e = editorRef.current;
    if (!e || e.isDestroyed) return;
    changeRef.current(e.getJSON(), e.getText({ blockSeparator: "\n" }));
  });
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      JournalCodeBlock,
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      AttachmentImage,
      AttachmentMedia,
      AttachmentFile,
      LinkCard,
      YoutubeEmbed,
      PromptBlock,
      DeadlineBar,
      MathBlock,
      LinkHighlight.configure({ onOpenLink: (t) => onOpenLink?.(t), onOpenTag: (t) => onOpenTag?.(t) }),
      LinkSuggest.configure({ pageNames: () => pageNames?.() ?? Promise.resolve([]) }),
      Timestamp,
      TimestampChip,
      EditStamp.configure({ isPastDay: () => !!pastDayRef.current }),
      FindHighlight,
      LogBlock,
      BlockInfoExtension,
      BlockBorn,
      LineIds,
      Blocks,
      AutoPairs,
      MathAuto,
      MathInline,
      SlashMenu.configure({ onReminder: () => onReminder?.() }),
    ],
    content: initialContent ?? "",
    // Normal paste keeps working; styling from other apps is stripped.
    editorProps: {
      // Keep the line being typed clear of the pinned header at the top and, on the phone, the
      // tool bar above the keyboard at the bottom.
      scrollThreshold: { top: 150, bottom: touch ? 150 : 40, left: 0, right: 0 },
      scrollMargin: { top: 170, bottom: touch ? 170 : 60, left: 0, right: 0 },
      transformPastedHTML: cleanPastedHTML,
      // Pasted or dropped files (photos, PDFs…) are stored and shown in the page.
      handlePaste: (_view, event) => {
        const editor = editorRef.current;
        const data = event.clipboardData;
        if (!editor || !data) return false;
        const files = [...data.files];
        if (files.length) {
          void insertFiles(editor, files);
          return true;
        }
        // Copied from this app: the HTML already carries the media, let the normal paste handle it.
        if (data.getData("text/html").includes("data-file-id")) return false;
        const text = data.getData("text/plain");
        // ![](youtube link), like Obsidian: a player right in the note.
        const yt = youtubeEmbedFrom(text);
        if (yt) {
          editor.chain().focus().insertContent({ type: "youtubeEmbed", attrs: yt }).run();
          return true;
        }
        // A lone link becomes a preview card (it falls back to a plain link by itself).
        if (isLoneUrl(text)) {
          editor.chain().focus().insertContent({ type: "linkCard", attrs: { url: text.trim() } }).run();
          return true;
        }
        if (!hasEmbeds(text)) return false;
        void pasteEmbeds(editor, text);
        return true;
      },
      // Copied text keeps media as ![[attachments/<id>/<name>]], like Obsidian.
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, "\n\n", mediaLeafText),
      handleDrop: (_view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length || !editorRef.current) return false;
        void insertFiles(editorRef.current, files);
        return true;
      },
    },
    autofocus: autofocus ? "end" : false,
    onCreate: ({ editor }) => {
      onReady?.(editor.getText({ blockSeparator: "\n" }));
      upgradeOldMedia(editor);
    },
    onUpdate: ({ editor, transaction }) => {
      // The other device's typing (live over Wi-Fi): shown, not saved here; its own save arrives by sync.
      if (transaction.getMeta(REMOTE)) return;
      // An opened note's lines only got their hidden ids: saved with the next real edit.
      if (transaction.getMeta(LID_INIT)) return;
      lastLocalEdit = Date.now();
      if (liveKeyRef.current) sendTyping(liveKeyRef.current, editor.state.doc);
      const actor = transaction.getMeta("aiActor") as string | undefined;
      if (actor) {
        // Anything typed before goes first, then the AI's edit on its own.
        if (pendingEmits.has(emit.current)) emit.current();
        return changeRef.current(editor.getJSON(), editor.getText({ blockSeparator: "\n" }), actor);
      }
      pendingEmits.add(emit.current);
      window.clearTimeout(emitTimer.current);
      emitTimer.current = window.setTimeout(emit.current, EMIT_DELAY_MS);
    },
  });

  // Leaving the note (another day, a linked page): hand over what was typed last.
  useEffect(() => () => {
    if (pendingEmits.has(emit.current)) emit.current();
  }, []);

  editorRef.current = editor;

  // Routine taps and reminder actions change this note through its editor while it's open.
  useEffect(() => (editor && liveKey ? registerOpenNote(liveKey, editor) : undefined), [editor, liveKey]);

  // The other device's typing in this same note, put in place as it happens.
  useEffect(() => {
    if (!editor || !liveKey) return;
    const on = (e: Event) => {
      const m = (e as CustomEvent<TypingMsg>).detail;
      // Never over this device's own fresh letters: those win, and the next full copy catches up.
      if (m.key !== liveKey || modeRef.current === "source" || Date.now() - lastLocalEdit < QUIET_MS || pendingEmits.size) return;
      applyTyping(editor, m);
    };
    window.addEventListener(TYPING_EVENT, on);
    return () => window.removeEventListener(TYPING_EVENT, on);
  }, [editor, liveKey]);

  // Reading mode: the note can't be changed (taps open links, play clips and show photos).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(mode !== "reading");
    if (mode === "reading") editor.commands.blur();
  }, [editor, mode]);

  // Source mode: the text is read back into a note as it's typed (saved like any edit), and the
  // editor takes it over again when Source mode ends.
  const sourceEmit = useRef(() => {
    window.clearTimeout(sourceTimer.current);
    pendingEmits.delete(sourceEmit.current);
    const s = source.current;
    if (!s) return;
    const doc = sourceToDoc(s.text, s.mem);
    changeRef.current(doc, docText(doc));
  });
  if (editor && mode === "source" && !source.current) {
    const json = editor.getJSON();
    const text = docToSource(json);
    source.current = { text, start: text, mem: sourceMemory(json) };
  }
  useEffect(() => {
    if (!editor || mode === "source") return;
    const s = source.current;
    if (!s) return;
    if (pendingEmits.has(sourceEmit.current)) sourceEmit.current();
    source.current = null;
    if (s.text !== s.start && !editor.isDestroyed) editor.commands.setContent(sourceToDoc(s.text, s.mem), { emitUpdate: false });
  }, [editor, mode]);
  useEffect(() => () => {
    if (pendingEmits.has(sourceEmit.current)) sourceEmit.current();
  }, []);
  const onSource = (text: string) => {
    if (!source.current) return;
    source.current.text = text;
    pendingEmits.add(sourceEmit.current);
    window.clearTimeout(sourceTimer.current);
    sourceTimer.current = window.setTimeout(sourceEmit.current, 400);
  };

  useEffect(() => {
    const open = () => setOutlineOpen(true);
    // Like Obsidian: Cmd/Ctrl+E switches Reading mode, Cmd/Ctrl+Shift+E Source mode, Cmd/Ctrl+Shift+O the outline.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const now = modeRef.current;
      if (k === "e" && !e.shiftKey) setViewMode(now === "reading" ? "live" : "reading");
      else if (k === "e" && e.shiftKey) setViewMode(now === "source" ? "live" : "source");
      else if (k === "o" && e.shiftKey) setOutlineOpen((o) => !o);
      else return;
      e.preventDefault();
    };
    window.addEventListener("journal:outline", open);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("journal:outline", open);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // The line being typed never sits under the bottom edge, the phone keyboard or its tool bar
  // (the window doesn't shrink for the keyboard on Android, so ProseMirror's own scrolling can't tell).
  useEffect(() => {
    if (!editor) return;
    let frame = 0;
    const keep = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!editor.isFocused || !editor.state.selection.empty) return;
        let r: { bottom: number };
        try {
          r = editor.view.coordsAtPos(editor.state.selection.head);
        } catch {
          return;
        }
        const vv = window.visualViewport;
        const visibleBottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - (touch ? 44 + 28 : 48);
        if (r.bottom > visibleBottom) window.scrollBy({ top: r.bottom - visibleBottom });
      });
    };
    editor.on("selectionUpdate", keep);
    editor.on("update", keep);
    window.visualViewport?.addEventListener("resize", keep);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("selectionUpdate", keep);
      editor.off("update", keep);
      window.visualViewport?.removeEventListener("resize", keep);
    };
  }, [editor, touch]);

  // Search hits: highlight them all, mark the current one and scroll it into the middle.
  const findTerms = find?.terms.join("\u0000") ?? "";
  const findIndex = find?.index ?? 0;
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { terms: findTerms ? findTerms.split("\u0000") : [], index: findIndex }));
    onFindCount?.(findKey.getState(editor.state)?.matches.length ?? 0);
    if (!findTerms) return;
    // The match may be folded away (under a folded block or heading, or in a folded code block):
    // unfold what hides it so it can be seen.
    const match = findKey.getState(editor.state)?.matches[findIndex];
    if (match) unfoldAround(editor, match.from);
    // The day was just opened: photos and clips above the match still load and push it down, and
    // focusing the note can scroll back to the top. Bring it to the middle again as that settles.
    const go = (behavior: ScrollBehavior) => {
      const hit = editor.view.dom.querySelector<HTMLElement>(".find-current");
      if (!hit) return;
      const r = hit.getBoundingClientRect();
      if (r.top > window.innerHeight * 0.25 && r.bottom < window.innerHeight * 0.75) return;
      window.scrollTo({ top: window.scrollY + r.top - window.innerHeight / 2 + r.height / 2, behavior });
    };
    const frame = requestAnimationFrame(() => go("smooth"));
    const timers = [400, 900, 1600, 2600].map((ms) => window.setTimeout(() => go("auto"), ms));
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((t) => window.clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, findTerms, findIndex]);

  // GIFs and stickers from the phone keyboard: Android hands them over natively (MainActivity),
  // and some keyboards send them as an input event carrying the file.
  useEffect(() => {
    if (!editor) return;
    const extension = (mime: string) => mime.split("/")[1]?.replace("jpeg", "jpg") || "bin";
    const host = window as unknown as { __journalReceiveContent?: (mime: string, data: string) => void };
    const receive = (mime: string, data: string) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      void insertFiles(editor, [new File([bytes], `keyboard-${Date.now()}.${extension(mime)}`, { type: mime })]);
    };
    host.__journalReceiveContent = receive;
    const onBeforeInput = (e: InputEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      void insertFiles(editor, files);
    };
    const dom = editor.view.dom;
    dom.addEventListener("beforeinput", onBeforeInput);
    return () => {
      dom.removeEventListener("beforeinput", onBeforeInput);
      if (host.__journalReceiveContent === receive) delete host.__journalReceiveContent;
    };
  }, [editor]);

  return (
    <div className={`editor mode-${mode}`}>
      <ModePill mode={mode} editor={editor} />
      {editor && mode === "source" && source.current && <SourceEditor value={source.current.text} onChange={onSource} touch={touch} autofocus={autofocus} />}
      {editor && outlineOpen && (
        <OutlinePanel
          editor={editor}
          day={liveKey?.startsWith("day:") ? liveKey.slice(4) : undefined}
          onClose={() => setOutlineOpen(false)}
          onJump={(pos) => {
            if (mode === "source") setViewMode("live");
            if (touch) setOutlineOpen(false);
            window.setTimeout(() => jumpTo(editor, pos, unfoldAround), mode === "source" ? 80 : 0);
          }}
        />
      )}
      {editor && timeRail && mode !== "source" && <TimeRail editor={editor} onJump={(pos) => jumpTo(editor, pos, unfoldAround)} />}
      {editor && !touch && mode === "live" && (
        // Keep focus in the editor so Enter after a toolbar click types, not re-clicks (from #2).
        <div className="toolbar" onMouseDown={(e) => e.preventDefault()}>
          <ToolbarButtons editor={editor} onInfo={() => setInfoOpen(true)} />
        </div>
      )}
      <EditorContent editor={editor} className={touch ? "editor-body with-keyboard-bar" : "editor-body"} />
      {editor && mode === "live" && <BlockHandle editor={editor} touch={touch} onInfo={() => setInfoOpen(true)} />}
      {editor && mode === "live" && <SmartPaste editor={editor} />}
      {editor && mode === "live" && <HotCaret editor={editor} />}
      {editor && infoOpen && <BlockInfoPanel editor={editor} onClose={() => setInfoOpen(false)} />}
      {touch && <ArrangeToolsHost />}
      {editor && touch && mode === "live" && (
        <KeyboardBar editor={editor} layout={toolLayout}>
          <ToolbarButtons editor={editor} onInfo={() => setInfoOpen(true)} phone />
        </KeyboardBar>
      )}
    </div>
  );
}
