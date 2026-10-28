import { useRef } from "react";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { cleanPastedHTML } from "../lib/smartPaste";
import { formatTimestamp } from "../lib/timestamp";
import { LinkHighlight } from "./linkHighlight";
import { AttachmentFile, AttachmentImage, insertFiles } from "./attachments";
import { KeyboardBar, useTouchDevice } from "./KeyboardBar";
import { LinkSuggest } from "./linkSuggest";
import { SlashMenu } from "./slashMenu";
import { SmartPaste } from "./SmartPaste";
import { Timestamp } from "./timestamp";
import { TimestampChip } from "./timestampChip";

interface Props {
  initialContent: JSONContent | null;
  onChange: (content: JSONContent, plainText: string) => void;
  onReady?: (plainText: string) => void;
  /** The "/" menu's Reminder tile: let the user pick a future day to write on. */
  onReminder?: () => void;
  onOpenLink?: (title: string) => void;
  onOpenTag?: (tag: string) => void;
  /** Names for [[ autocomplete. */
  pageNames?: () => Promise<string[]>;
  autofocus?: boolean;
}

/** Formatting buttons, shared by the top toolbar (Mac) and the bar above the phone keyboard. */
function ToolbarButtons({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bullet: e.isActive("bulletList"),
      task: e.isActive("taskList"),
      ordered: e.isActive("orderedList"),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      highlight: e.isActive("highlight"),
    }),
  });

  const buttons: { key: keyof typeof active | "timestamp"; label: string; title: string; run: () => void }[] = [
    { key: "bullet", label: "•", title: "Bullet list", run: () => editor.chain().focus().toggleBulletList().run() },
    { key: "task", label: "☑", title: "Task list", run: () => editor.chain().focus().toggleTaskList().run() },
    { key: "ordered", label: "1.", title: "Numbered list", run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: "bold", label: "B", title: "Bold (Cmd/Ctrl+B)", run: () => editor.chain().focus().toggleBold().run() },
    { key: "italic", label: "I", title: "Italic (Cmd/Ctrl+I)", run: () => editor.chain().focus().toggleItalic().run() },
    { key: "highlight", label: "H", title: "Highlight (Cmd/Ctrl+Shift+H)", run: () => editor.chain().focus().toggleHighlight().run() },
    {
      key: "timestamp",
      label: "🕒",
      title: "Insert timestamp (Cmd/Ctrl+Shift+T)",
      run: () => editor.chain().focus().insertContent(formatTimestamp(new Date()) + " ").run(),
    },
  ];

  return (
    <>
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          title={b.title}
          aria-label={b.title}
          aria-pressed={b.key === "timestamp" ? undefined : active[b.key]}
          className={`tool tool-${b.key}${b.key !== "timestamp" && active[b.key] ? " active" : ""}`}
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
  initialContent, onChange, onReady, onReminder, onOpenLink, onOpenTag, pageNames, autofocus = true,
}: Props) {
  const touch = useTouchDevice();
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      AttachmentImage,
      AttachmentFile,
      LinkHighlight.configure({ onOpenLink: (t) => onOpenLink?.(t), onOpenTag: (t) => onOpenTag?.(t) }),
      LinkSuggest.configure({ pageNames: () => pageNames?.() ?? Promise.resolve([]) }),
      Timestamp,
      TimestampChip,
      SlashMenu.configure({ onReminder: () => onReminder?.() }),
    ],
    content: initialContent ?? "",
    // Normal paste keeps working; styling from other apps is stripped.
    editorProps: {
      transformPastedHTML: cleanPastedHTML,
      // Pasted or dropped files (photos, PDFs…) are stored and shown in the page.
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || !editorRef.current) return false;
        void insertFiles(editorRef.current, files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length || !editorRef.current) return false;
        void insertFiles(editorRef.current, files);
        return true;
      },
    },
    autofocus: autofocus ? "end" : false,
    onCreate: ({ editor }) => onReady?.(editor.getText({ blockSeparator: "\n" })),
    onUpdate: ({ editor }) => onChange(editor.getJSON(), editor.getText({ blockSeparator: "\n" })),
  });

  editorRef.current = editor;

  return (
    <div className="editor">
      {editor && !touch && (
        // Keep focus in the editor so Enter after a toolbar click types, not re-clicks (from #2).
        <div className="toolbar" onMouseDown={(e) => e.preventDefault()}>
          <ToolbarButtons editor={editor} />
        </div>
      )}
      <EditorContent editor={editor} className={touch ? "editor-body with-keyboard-bar" : "editor-body"} />
      {editor && <SmartPaste editor={editor} />}
      {editor && touch && (
        <KeyboardBar editor={editor}>
          <ToolbarButtons editor={editor} />
        </KeyboardBar>
      )}
    </div>
  );
}
