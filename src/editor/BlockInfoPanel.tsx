import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { cleanInfo, loadInfoDefaults, saveInfoDefaults, type BlockInfo } from "../lib/blockInfo";

const TYPES = ["taskItem", "listItem", "heading", "paragraph"];

/** The block the cursor is in (innermost of paragraph/heading/list item/task), with its position. */
function currentBlock(editor: Editor): { pos: number; info: BlockInfo | null } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (TYPES.includes(node.type.name)) return { pos: $from.before(d), info: node.attrs.info ?? null };
  }
  return null;
}

/** Edit the info on the current block, and optionally make it the default for new blocks. */
export function BlockInfoPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const block = currentBlock(editor);
  const defaults = loadInfoDefaults();
  const [rows, setRows] = useState<[string, string][]>(() => {
    const start = Object.entries(block?.info ?? {});
    return start.length ? start : [["", ""]];
  });
  const [asDefault, setAsDefault] = useState(() => Object.keys(defaults).length > 0 && JSON.stringify(cleanInfo(defaults)) === JSON.stringify(cleanInfo(block?.info)));

  if (!block) return null;
  const save = () => {
    const info = cleanInfo(Object.fromEntries(rows));
    editor.chain().focus().command(({ tr }) => {
      tr.setNodeAttribute(block.pos, "info", info).setMeta("noInfoDefaults", true);
      return true;
    }).run();
    // From now on new blocks get this info; earlier blocks keep theirs.
    if (asDefault) saveInfoDefaults(info ?? {});
    else if (JSON.stringify(cleanInfo(defaults)) === JSON.stringify(info)) saveInfoDefaults({});
    onClose();
  };

  return (
    <>
      <div className="search-backdrop" onClick={onClose} />
      <form className="confirm-card" onSubmit={(e) => (e.preventDefault(), save())}>
        <h2>ⓘ Block info</h2>
        {rows.map(([k, v], i) => (
          <div key={i} className="settings-row">
            <input aria-label="Property" placeholder="Property (e.g. Mood)" value={k} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
            <input aria-label="Value" placeholder="Value" value={v} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
            <button type="button" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" onClick={() => setRows([...rows, ["", ""]])}>＋ Property</button>
        <label className="settings-toggle">
          <input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
          Use for new blocks from now on (past blocks don't change)
        </label>
        {Object.keys(defaults).length > 0 && !asDefault && <p className="hint">New blocks currently get: {Object.entries(defaults).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit">Save</button>
        </div>
      </form>
    </>
  );
}
