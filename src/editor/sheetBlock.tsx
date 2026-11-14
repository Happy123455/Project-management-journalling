import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { colIndex, colName, display, emptySheet, evaluate, fill, isError, MAX_COLS, MAX_ROWS, normRange, parseSheet, refName, setCells, sheetText, type Range, type SheetData } from "../lib/sheet";

/**
 * ▦ A spreadsheet table in the note (a "sheet" block): arrow keys, Enter and Tab move like a
 * spreadsheet, typing replaces a cell, = starts a formula, the corner square fills down or across,
 * and copy/paste speaks tab-separated text (Excel, Numbers, Google Sheets). Everything is kept in
 * the block's `data`, so it saves, syncs and undoes like the rest of the note.
 */

interface Cell {
  r: number;
  c: number;
}

const inRange = (g: Range, r: number, c: number) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
const cellAt = (x: number, y: number): Cell | null => {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-r][data-c]");
  return el ? { r: Number(el.dataset.r), c: Number(el.dataset.c) } : null;
};

function SheetView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const data = useMemo(() => parseSheet(node.attrs.data), [node.attrs.data]);
  const values = useMemo(() => evaluate(data), [data]);
  const editable = editor.isEditable;
  const [active, setActive] = useState<Cell>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Cell>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ draft: string; bar?: boolean } | null>(null);
  const [fillTo, setFillTo] = useState<Range | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sel = normRange(anchor, active);

  const save = (next: SheetData) => updateAttributes({ data: JSON.stringify(next) });
  const raw = (r: number, c: number) => data.cells[refName(r, c)] ?? "";

  // Keep the active cell inside the sheet when rows or columns go.
  useEffect(() => {
    if (active.r >= data.rows || active.c >= data.cols) {
      const a = { r: Math.min(active.r, data.rows - 1), c: Math.min(active.c, data.cols - 1) };
      setActive(a);
      setAnchor(a);
    }
  }, [data.rows, data.cols, active.r, active.c]);

  useEffect(() => {
    if (editing && !editing.bar) input.current?.focus();
  }, [editing]);

  const move = (dr: number, dc: number, extend = false) => {
    const a = { r: Math.min(data.rows - 1, Math.max(0, active.r + dr)), c: Math.min(data.cols - 1, Math.max(0, active.c + dc)) };
    setActive(a);
    if (!extend) setAnchor(a);
    grid.current?.querySelector<HTMLElement>(`[data-r="${a.r}"][data-c="${a.c}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const commit = (text: string, then?: [number, number]) => {
    setEditing(null);
    const key = refName(active.r, active.c);
    if ((data.cells[key] ?? "") !== text) {
      const next = setCells(data, { [key]: text });
      if (typeof next !== "string") save(next);
    }
    // Typing in the last row and pressing Enter adds a row, like a list.
    if (then) {
      if (then[0] > 0 && active.r === data.rows - 1 && data.rows < MAX_ROWS) {
        const next = setCells(parseSheet(JSON.stringify({ ...data, rows: data.rows + 1 })), { [key]: text });
        if (typeof next !== "string") save(next);
        const a = { r: active.r + 1, c: active.c };
        setActive(a);
        setAnchor(a);
      } else move(then[0], then[1]);
    }
    grid.current?.focus({ preventScroll: true });
  };

  const clearSelection = () => {
    const patch: Record<string, string> = {};
    for (let r = sel.r0; r <= sel.r1; r++) for (let c = sel.c0; c <= sel.c1; c++) patch[refName(r, c)] = "";
    const next = setCells(data, patch);
    if (typeof next !== "string") save(next);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!editable || editing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (k === "ArrowUp") move(-1, 0, e.shiftKey);
    else if (k === "ArrowDown") move(1, 0, e.shiftKey);
    else if (k === "ArrowLeft") move(0, -1, e.shiftKey);
    else if (k === "ArrowRight") move(0, 1, e.shiftKey);
    else if (k === "Tab") move(0, e.shiftKey ? -1 : 1);
    else if (k === "Enter" || k === "F2") setEditing({ draft: raw(active.r, active.c) });
    else if (k === "Delete" || k === "Backspace") clearSelection();
    else if (mod && k.toLowerCase() === "c") void copy();
    else if (mod && k.toLowerCase() === "x") void copy().then(clearSelection);
    else if (mod && k.toLowerCase() === "z") return; // the note's undo
    else if (!mod && !e.altKey && k.length === 1) setEditing({ draft: k });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onEditKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const v = e.currentTarget.value;
    if (e.key === "Enter") commit(v, [e.shiftKey ? -1 : 1, 0]);
    else if (e.key === "Tab") commit(v, [0, e.shiftKey ? -1 : 1]);
    else if (e.key === "Escape") {
      setEditing(null);
      grid.current?.focus({ preventScroll: true });
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !v.startsWith("=")) commit(v, [e.key === "ArrowUp" ? -1 : 1, 0]);
    else return e.stopPropagation();
    e.preventDefault();
    e.stopPropagation();
  };

  const copy = async () => {
    const lines: string[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) row.push(display(values.get(refName(r, c))));
      lines.push(row.join("\t"));
    }
    await navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!editable || editing) return;
    const t = e.clipboardData.getData("text/plain");
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const rows = t.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    const patch: Record<string, string> = {};
    rows.forEach((row, i) => row.forEach((v, j) => {
      if (active.r + i < MAX_ROWS && active.c + j < MAX_COLS) patch[refName(active.r + i, active.c + j)] = v;
    }));
    const next = setCells(data, patch);
    if (typeof next !== "string") save(next);
  };

  // Pointer: press selects (drag selects a range with a mouse); the corner square fills.
  const drag = useRef<"select" | "fill" | null>(null);
  const onCellDown = (e: React.PointerEvent, r: number, c: number) => {
    if (!editable) return;
    if (editing) commit(input.current?.value ?? editing.draft);
    const already = r === active.r && c === active.c && sel.r0 === sel.r1 && sel.c0 === sel.c1;
    if (e.shiftKey) setActive({ r, c });
    else {
      setActive({ r, c });
      setAnchor({ r, c });
    }
    // A second tap on the same cell edits it (the keyboard comes up on a phone).
    if (already && e.pointerType !== "mouse") {
      setEditing({ draft: raw(r, c) });
      return;
    }
    if (e.pointerType === "mouse") {
      drag.current = "select";
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    grid.current?.focus({ preventScroll: true });
  };
  const onFillDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = "fill";
    setFillTo(sel);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const at = cellAt(e.clientX, e.clientY);
    if (!at) return;
    if (drag.current === "select") return void setActive(at);
    // Fill grows along the longer way out of the selection: down/up or across.
    const dr = at.r > sel.r1 ? at.r - sel.r1 : at.r < sel.r0 ? at.r - sel.r0 : 0;
    const dc = at.c > sel.c1 ? at.c - sel.c1 : at.c < sel.c0 ? at.c - sel.c0 : 0;
    if (Math.abs(dr) >= Math.abs(dc)) setFillTo({ ...sel, r0: Math.min(sel.r0, at.r), r1: Math.max(sel.r1, at.r) });
    else setFillTo({ ...sel, c0: Math.min(sel.c0, at.c), c1: Math.max(sel.c1, at.c) });
  };
  const onUp = () => {
    if (drag.current === "fill" && fillTo && (fillTo.r0 !== sel.r0 || fillTo.r1 !== sel.r1 || fillTo.c0 !== sel.c0 || fillTo.c1 !== sel.c1)) {
      save(fill(data, sel, fillTo));
      setAnchor({ r: fillTo.r0, c: fillTo.c0 });
      setActive({ r: fillTo.r1, c: fillTo.c1 });
    }
    drag.current = null;
    setFillTo(null);
  };
  // A fill dragged past the last row or column grows the sheet: offer one more row/column while filling.
  const shownRows = fillTo ? Math.max(data.rows, Math.min(MAX_ROWS, fillTo.r1 + 2)) : data.rows;
  const shownCols = fillTo ? Math.max(data.cols, Math.min(MAX_COLS, fillTo.c1 + 2)) : data.cols;

  const addRow = () => data.rows < MAX_ROWS && save({ ...data, rows: data.rows + 1 });
  const addCol = () => data.cols < MAX_COLS && save({ ...data, cols: data.cols + 1 });
  const removeLine = (kind: "row" | "col") => {
    const at = kind === "row" ? active.r : active.c;
    if ((kind === "row" ? data.rows : data.cols) <= 1) return;
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(k)!;
      const r = Number(m[2]) - 1;
      const c = colIndex(m[1]);
      if ((kind === "row" ? r : c) === at) continue;
      const nr = kind === "row" && r > at ? r - 1 : r;
      const nc = kind === "col" && c > at ? c - 1 : c;
      cells[refName(nr, nc)] = v;
    }
    save({ ...data, cells, rows: kind === "row" ? data.rows - 1 : data.rows, cols: kind === "col" ? data.cols - 1 : data.cols });
  };

  const activeRaw = raw(active.r, active.c);
  const fillCorner = sel;
  return (
    <NodeViewWrapper className={`sheet-wrap${selected ? " is-selected" : ""}`} contentEditable={false} data-drag-handle="">
      <div className="sheet-bar">
        <span className="sheet-ref">{sel.r0 === sel.r1 && sel.c0 === sel.c1 ? refName(active.r, active.c) : `${refName(sel.r0, sel.c0)}:${refName(sel.r1, sel.c1)}`}</span>
        <input
          className="sheet-formula"
          value={editing ? editing.draft : activeRaw}
          readOnly={!editable}
          placeholder={editable ? "Type a value or =SUM(A1:A3)" : ""}
          onFocus={() => editable && !editing && setEditing({ draft: activeRaw, bar: true })}
          onChange={(e) => setEditing({ draft: e.target.value, bar: true })}
          onKeyDown={onEditKey}
          onBlur={(e) => editing?.bar && commit(e.target.value)}
          aria-label="Cell contents"
          spellCheck={false}
        />
        {editable && (
          <span className="sheet-tools">
            <button type="button" onClick={addRow} title="Add a row">+ Row</button>
            <button type="button" onClick={addCol} title="Add a column">+ Col</button>
            <button type="button" onClick={() => removeLine("row")} title={`Delete row ${active.r + 1}`}>− Row</button>
            <button type="button" onClick={() => removeLine("col")} title={`Delete column ${colName(active.c)}`}>− Col</button>
          </span>
        )}
      </div>
      <div className="sheet-grid" ref={grid} tabIndex={0} onKeyDown={onKeyDown} onPaste={onPaste} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} role="grid" aria-label="Spreadsheet">
        <table>
          <thead>
            <tr>
              <th className="sheet-corner" />
              {Array.from({ length: shownCols }, (_, c) => (
                <th key={c} className={c >= sel.c0 && c <= sel.c1 ? "on" : ""} style={data.widths?.[c] ? { width: data.widths[c], minWidth: data.widths[c] } : undefined}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: shownRows }, (_, r) => (
              <tr key={r}>
                <th className={r >= sel.r0 && r <= sel.r1 ? "on" : ""}>{r + 1}</th>
                {Array.from({ length: shownCols }, (_, c) => {
                  const key = refName(r, c);
                  const v = values.get(key);
                  const isActive = r === active.r && c === active.c;
                  const cls = [
                    inRange(sel, r, c) && "sel",
                    isActive && "active",
                    fillTo && inRange(fillTo, r, c) && !inRange(sel, r, c) && "filling",
                    typeof v === "number" && "num",
                    isError(v) && "err",
                    data.cells[key]?.startsWith("=") && "fx",
                  ].filter(Boolean).join(" ");
                  return (
                    <td key={c} data-r={r} data-c={c} className={cls} onPointerDown={(e) => onCellDown(e, r, c)} onDoubleClick={() => editable && setEditing({ draft: raw(r, c) })} role="gridcell" aria-selected={inRange(sel, r, c)}>
                      {isActive && editing && !editing.bar ? (
                        <input ref={input} className="sheet-edit" value={editing.draft} onChange={(e) => setEditing({ draft: e.target.value })} onKeyDown={onEditKey} onBlur={(e) => commit(e.target.value)} spellCheck={false} />
                      ) : (
                        display(v)
                      )}
                      {editable && !editing && !fillTo && r === fillCorner.r1 && c === fillCorner.c1 && <i className="sheet-fill" onPointerDown={onFillDown} title="Drag to fill" />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </NodeViewWrapper>
  );
}

export const SheetBlock = Node.create({
  name: "sheetBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      data: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-sheet") ?? "",
        renderHTML: (attrs) => (attrs.data ? { "data-sheet": attrs.data } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-sheet-block]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-sheet-block": "" }), sheetText(parseSheet(node.attrs.data))];
  },
  renderText({ node }) {
    return sheetText(parseSheet(node.attrs.data));
  },
  addNodeView() {
    return ReactNodeViewRenderer(SheetView, {
      // Keys, pointers and paste inside the table are the table's, not the note's.
      stopEvent: ({ event }: { event: Event }) => !!(event.target as HTMLElement | null)?.closest?.(".sheet-grid, .sheet-bar"),
    });
  },
});

/** A new table, ready to type in. */
export const newSheetContent = () => ({ type: "sheetBlock", attrs: { data: JSON.stringify(emptySheet(5, 4)) } });
