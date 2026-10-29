import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { cleanPastedHTML } from "../lib/smartPaste";
import { formatTimestamp } from "../lib/timestamp";
import { LinkHighlight } from "./linkHighlight";
import { hasEmbeds } from "../lib/embeds";
import { AttachmentFile, AttachmentImage, AttachmentMedia, insertFiles, mediaLeafText, pasteEmbeds, upgradeOldMedia } from "./attachments";
import { JournalCodeBlock } from "./codeBlock";
import { BlockInfoExtension } from "./blockInfo";
import { BlockHandle } from "./BlockHandle";
import { blockIndexAt, Blocks, indentBlock } from "./blocks";
import { AutoPairs } from "./autoPairs";
import { BlockInfoPanel } from "./BlockInfoPanel";
import { saveToInspiration } from "./inspiration";
import { readAloud } from "../lib/readAloud";
import { isLoneUrl, LinkCard } from "./linkCard";
import { PromptBlock } from "./promptBlock";
import { FindHighlight, findKey } from "./findHighlight";
import { LogBlock } from "./logBlock";
import { KeyboardBar, useTouchDevice } from "./KeyboardBar";
import { LinkSuggest } from "./linkSuggest";
import { SlashMenu } from "./slashMenu";
import { SmartPaste } from "./SmartPaste";
import { Timestamp } from "./timestamp";
import { TimestampChip } from "./timestampChip";

interface Props {
  initialContent: JSONContent | null;
  /** `actor` is set when the change came from an AI (the transaction's "aiActor" meta). */
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
}

interface Tool {
  key: string;
  label: string;
  title: string;
  run: () => void;
  active?: boolean;
  disabled?: boolean;
}

const TOOLS_KEY = "dynamic-journal.toolbar";
/** The phone bar's tool order and hidden tools, kept on this device. */
export function loadToolLayout(): { order: string[]; hidden: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(TOOLS_KEY) ?? "{}");
    return { order: Array.isArray(v.order) ? v.order : [], hidden: Array.isArray(v.hidden) ? v.hidden : [] };
  } catch {
    return { order: [], hidden: [] };
  }
}
function saveToolLayout(layout: { order: string[]; hidden: string[] }) {
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(layout));
  } catch {
    // Only a convenience.
  }
}
/** Tools in the saved order (new tools go at the end), without hidden ones unless asked. */
export function arrangeTools<T extends { key: string }>(tools: T[], layout: { order: string[]; hidden: string[] }, withHidden = false): T[] {
  const rank = (k: string) => {
    const i = layout.order.indexOf(k);
    return i < 0 ? layout.order.length + tools.findIndex((t) => t.key === k) : i;
  };
  return [...tools].sort((a, b) => rank(a.key) - rank(b.key)).filter((t) => withHidden || !layout.hidden.includes(t.key));
}

/** Formatting buttons, shared by the top toolbar (Mac) and the bar above the phone keyboard. */
function ToolbarButtons({ editor, onInfo, phone }: { editor: Editor; onInfo: () => void; phone?: boolean }) {
  const [layout, setLayout] = useState(loadToolLayout);
  const [arranging, setArranging] = useState(false);
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
    { key: "code", label: "</>", title: "Code block (or type ``` and Enter)", active: active.code, run: () => editor.chain().focus().toggleCodeBlock().run() },
    { key: "timestamp", label: "🕒", title: "Insert timestamp (Cmd/Ctrl+Shift+T)", run: () => editor.chain().focus().insertContent(formatTimestamp(new Date()) + " ").run() },
    { key: "info", label: "ⓘ", title: "Block info", run: onInfo },
    {
      key: "inspire",
      label: "✨",
      title: "Save this block to Inspiration",
      run: () => void saveToInspiration(editor, document.querySelector(".page-header h1")?.textContent?.trim() ?? ""),
    },
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
  const shown = phone ? [...arrangeTools(tools, layout), { key: "arrange", label: "⚙︎", title: "Arrange tools", run: () => setArranging(true) }] : tools;
  const update = (next: { order: string[]; hidden: string[] }) => {
    setLayout(next);
    saveToolLayout(next);
  };

  return (
    <>
      {shown.map((b) => (
        <button
          key={b.key}
          type="button"
          title={b.title}
          aria-label={b.title}
          aria-pressed={"active" in b ? b.active : undefined}
          disabled={"disabled" in b ? b.disabled : false}
          className={`tool tool-${b.key}${"active" in b && b.active ? " active" : ""}`}
          // Keep the editor focused so the phone keyboard stays open.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={b.run}
        >
          {b.label}
        </button>
      ))}
      {arranging && createPortal(
        <div className="arrange-tools" role="dialog" aria-label="Arrange tools" onPointerDown={(e) => e.stopPropagation()}>
          <div className="arrange-head">
            <strong>Arrange tools</strong>
            <button type="button" onClick={() => update({ order: [], hidden: [] })}>Reset</button>
            <button type="button" onClick={() => setArranging(false)}>Done</button>
          </div>
          <ul>
            {arrangeTools(tools, layout, true).map((t, i, all) => {
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
      )}
    </>
  );
}

export function JournalEditor({
  initialContent, onChange, onReady, onReminder, onOpenLink, onOpenTag, pageNames, autofocus = true, find, onFindCount,
}: Props) {
  const touch = useTouchDevice();
  const [infoOpen, setInfoOpen] = useState(false);
  const editorRef = useRef<Editor | null>(null);
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
      PromptBlock,
      LinkHighlight.configure({ onOpenLink: (t) => onOpenLink?.(t), onOpenTag: (t) => onOpenTag?.(t) }),
      LinkSuggest.configure({ pageNames: () => pageNames?.() ?? Promise.resolve([]) }),
      Timestamp,
      TimestampChip,
      FindHighlight,
      LogBlock,
      BlockInfoExtension,
      Blocks,
      AutoPairs,
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
    onUpdate: ({ editor, transaction }) =>
      onChange(editor.getJSON(), editor.getText({ blockSeparator: "\n" }), transaction.getMeta("aiActor") as string | undefined),
  });

  editorRef.current = editor;

  // Search hits: highlight them all, mark the current one and scroll it into the middle.
  const findTerms = find?.terms.join("\u0000") ?? "";
  const findIndex = find?.index ?? 0;
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { terms: findTerms ? findTerms.split("\u0000") : [], index: findIndex }));
    onFindCount?.(findKey.getState(editor.state)?.matches.length ?? 0);
    if (findTerms) requestAnimationFrame(() => editor.view.dom.querySelector(".find-current")?.scrollIntoView({ block: "center", behavior: "smooth" }));
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
    <div className="editor">
      {editor && !touch && (
        // Keep focus in the editor so Enter after a toolbar click types, not re-clicks (from #2).
        <div className="toolbar" onMouseDown={(e) => e.preventDefault()}>
          <ToolbarButtons editor={editor} onInfo={() => setInfoOpen(true)} />
        </div>
      )}
      <EditorContent editor={editor} className={touch ? "editor-body with-keyboard-bar" : "editor-body"} />
      {editor && <BlockHandle editor={editor} touch={touch} onInfo={() => setInfoOpen(true)} />}
      {editor && <SmartPaste editor={editor} />}
      {editor && infoOpen && <BlockInfoPanel editor={editor} onClose={() => setInfoOpen(false)} />}
      {editor && touch && (
        <KeyboardBar editor={editor}>
          <ToolbarButtons editor={editor} onInfo={() => setInfoOpen(true)} phone />
        </KeyboardBar>
      )}
    </div>
  );
}
