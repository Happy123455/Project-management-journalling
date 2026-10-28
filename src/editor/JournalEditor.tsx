import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { formatTimestamp } from "../lib/timestamp";
import { LinkHighlight } from "./linkHighlight";
import { Timestamp } from "./timestamp";

interface Props {
  initialContent: JSONContent | null;
  onChange: (content: JSONContent, plainText: string) => void;
  onReady?: (plainText: string) => void;
}

export function JournalEditor({ initialContent, onChange, onReady }: Props) {
  const editor = useEditor({
    extensions: [StarterKit, LinkHighlight, Timestamp],
    content: initialContent ?? "",
    autofocus: "end",
    onCreate: ({ editor }) => onReady?.(editor.getText({ blockSeparator: "\n" })),
    onUpdate: ({ editor }) => onChange(editor.getJSON(), editor.getText({ blockSeparator: "\n" })),
  });

  return (
    <div className="editor">
      <div className="toolbar">
        <button
          type="button"
          title="Insert timestamp (Cmd/Ctrl+Shift+T)"
          onClick={() => editor?.chain().focus().insertContent(formatTimestamp(new Date()) + " ").run()}
        >
          🕒 Timestamp
        </button>
        <button type="button" title="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          • List
        </button>
        <button type="button" title="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          1. List
        </button>
      </div>
      <EditorContent editor={editor} className="editor-body" />
    </div>
  );
}
