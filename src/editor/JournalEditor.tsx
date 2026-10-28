import { useEffect, useRef, useState } from "react";
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
import { BlockInfoPanel } from "./BlockInfoPanel";
import { isLoneUrl, LinkCard } from "./linkCard";
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

/** Formatting buttons, shared by the top toolbar (Mac) and the bar above the phone keyboard. */
function ToolbarButtons({ editor, onInfo }: { editor: Editor; onInfo: () => void }) {
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

  const history = [
    { key: "undo", label: "↶", title: "Undo (Cmd/Ctrl+Z)", enabled: active.canUndo, run: () => editor.chain().focus().undo().run() },
    { key: "redo", label: "↷", title: "Redo (Cmd/Ctrl+Shift+Z)", enabled: active.canRedo, run: () => editor.chain().focus().redo().run() },
  ];

  const buttons: { key: Exclude<keyof typeof active, "canUndo" | "canRedo"> | "timestamp" | "info"; label: string; title: string; run: () => void }[] = [
    { key: "bullet", label: "•", title: "Bullet list", run: () => editor.chain().focus().toggleBulletList().run() },
    { key: "task", label: "☑", title: "Task list", run: () => editor.chain().focus().toggleTaskList().run() },
    { key: "ordered", label: "1.", title: "Numbered list", run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: "bold", label: "B", title: "Bold (Cmd/Ctrl+B)", run: () => editor.chain().focus().toggleBold().run() },
    { key: "italic", label: "I", title: "Italic (Cmd/Ctrl+I)", run: () => editor.chain().focus().toggleItalic().run() },
    { key: "highlight", label: "H", title: "Highlight (Cmd/Ctrl+Shift+H)", run: () => editor.chain().focus().toggleHighlight().run() },
    { key: "code", label: "</>", title: "Code block (or type ``` and Enter)", run: () => editor.chain().focus().toggleCodeBlock().run() },
    { key: "info", label: "ⓘ", title: "Block info", run: onInfo },
    {
      key: "timestamp",
      label: "🕒",
      title: "Insert timestamp (Cmd/Ctrl+Shift+T)",
      run: () => editor.chain().focus().insertContent(formatTimestamp(new Date()) + " ").run(),
    },
  ];

  return (
    <>
      {history.map((b) => (
        <button
          key={b.key}
          type="button"
          title={b.title}
          aria-label={b.title}
          disabled={!b.enabled}
          className={`tool tool-${b.key}`}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={b.run}
        >
          {b.label}
        </button>
      ))}
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          title={b.title}
          aria-label={b.title}
          aria-pressed={b.key === "timestamp" || b.key === "info" ? undefined : active[b.key]}
          className={`tool tool-${b.key}${b.key !== "timestamp" && b.key !== "info" && active[b.key] ? " active" : ""}`}
          // Keep the editor focused so the phone keyboard stays open.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={b.run}
        >
          {b.label}
        </button>
      ))}
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
      LinkHighlight.configure({ onOpenLink: (t) => onOpenLink?.(t), onOpenTag: (t) => onOpenTag?.(t) }),
      LinkSuggest.configure({ pageNames: () => pageNames?.() ?? Promise.resolve([]) }),
      Timestamp,
      TimestampChip,
      FindHighlight,
      LogBlock,
      BlockInfoExtension,
      SlashMenu.configure({ onReminder: () => onReminder?.() }),
    ],
    content: initialContent ?? "",
    // Normal paste keeps working; styling from other apps is stripped.
    editorProps: {
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
      {editor && <SmartPaste editor={editor} />}
      {editor && infoOpen && <BlockInfoPanel editor={editor} onClose={() => setInfoOpen(false)} />}
      {editor && touch && (
        <KeyboardBar editor={editor}>
          <ToolbarButtons editor={editor} onInfo={() => setInfoOpen(true)} />
        </KeyboardBar>
      )}
    </div>
  );
}
