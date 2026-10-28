import { Extension } from "@tiptap/react";
import { formatTimestamp } from "../lib/timestamp";

/** Cmd/Ctrl+Shift+T inserts the one-click timestamp at the cursor. */
export const Timestamp = Extension.create({
  name: "timestamp",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-t": () => this.editor.commands.insertContent(formatTimestamp(new Date()) + " "),
    };
  },
});
