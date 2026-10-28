import { Extension } from "@tiptap/react";
import { formatTimestamp, TIMESTAMP_RE } from "../lib/timestamp";

/** True when a list item's text starts with a timestamp (a log entry). */
export function isLogEntry(text: string): boolean {
  const m = [...text.matchAll(TIMESTAMP_RE)][0];
  return !!m && m.index === 0;
}

/**
 * In a log (a list whose entries start with a timestamp), Enter at the end of an entry starts
 * the next one with the current time. Enter on an empty entry ends the log as usual.
 */
export const LogBlock = Extension.create({
  name: "logBlock",
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return false;
        if ($from.depth < 2 || $from.node($from.depth - 1).type.name !== "listItem") return false;
        const text = $from.parent.textContent;
        if (!isLogEntry(text) || !text.replace(TIMESTAMP_RE, "").trim()) return false;
        return editor.chain().splitListItem("listItem").insertContent(formatTimestamp(new Date()) + " ").run();
      },
    };
  },
});
