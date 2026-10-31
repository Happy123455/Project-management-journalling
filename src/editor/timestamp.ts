import { Extension } from "@tiptap/react";
import { formatTimestamp, TIMESTAMP_RE } from "../lib/timestamp";
import { EDIT_MARK } from "./timestampChip";

/**
 * Cmd/Ctrl+Shift+T inserts the one-click timestamp at the cursor.
 * Backspace right after a timestamp removes it whole, since it shows as a single chip.
 */
export const Timestamp = Extension.create({
  name: "timestamp",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-t": () => this.editor.commands.insertContent(formatTimestamp(new Date()) + " "),
      Backspace: () => {
        const { empty, $from } = this.editor.state.selection;
        if (!empty) return false;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
        const match = [...before.matchAll(TIMESTAMP_RE)].pop();
        if (!match || match.index + match[0].length !== before.length) return false;
        // An edit stamp goes with its "✎ " too.
        const mark = before.slice(0, match.index).endsWith(EDIT_MARK) ? EDIT_MARK.length : 0;
        return this.editor.commands.deleteRange({ from: $from.pos - match[0].length - mark, to: $from.pos });
      },
    };
  },
});
