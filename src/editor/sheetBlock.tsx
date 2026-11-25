import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { colIndex, colName, display, emptySheet, evaluate, fill, isError, MAX_COLS, MAX_ROWS, moveLine, normRange, parseSheet, refName, setCells, sheetText, type Range, type SheetData } from "../lib/sheet";

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

/**
 * How long a finger rests on a cell before it starts a range (and the table stops scrolling under
 * it). 350 ms caught fingers that paused before a swipe, so the note seemed stuck on the table.
 */
const HOLD_MS = 500;

const inRange = (g: Range, r: number, c: number) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
const cellAt = (x: number, y: number): Cell | null => {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-r][data-c]");
  return el ? { r: Number(el.dataset.r), c: Number(el.dataset.c) } : null;
};

function SheetView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const data = useMemo(() => parseSheet(node.attrs.data), [node.attrs.data]);
  // Item 11 (18 Nov): a plain table for words, or the Excel-style sheet for sums; switching keeps
  // every cell as typed (a formula in a plain table shows as written, and works again in Excel).
  const plain = data.mode === "table";
  const values = useMemo(() => (plain ? new Map(Object.entries(data.cells).map(([k, v]) => [k, v])) : evaluate(data)), [data, plain]);
  // Live: the editor can turn editable after the table was drawn (Reading → Edit, a note opened
  // while loading). Reading it once at render left those tables stuck read-only.
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const sync = () => setEditable(editor.isEditable);
    sync();
    editor.on("update", sync);
    editor.on("transaction", sync);
    return () => {
      editor.off("update", sync);
      editor.off("transaction", sync);
    };
  }, [editor]);
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

  /** Tab-separated text (a copy from a spreadsheet) into the cells from the selection's top-left. */
  const pasteText = (t: string) => {
    const rows = t.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    const patch: Record<string, string> = {};
    rows.forEach((row, i) => row.forEach((v, j) => {
      if (sel.r0 + i < MAX_ROWS && sel.c0 + j < MAX_COLS) patch[refName(sel.r0 + i, sel.c0 + j)] = v;
    }));
    const next = setCells(data, patch);
    if (typeof next !== "string") save(next);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (!editable || editing) return;
    const t = e.clipboardData.getData("text/plain");
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    pasteText(t);
  };
  /** Fill ↓ / → on a touch selection: its first row (or column) repeated or continued over the rest. */
  const fillWithin = (down: boolean) => {
    if (down ? sel.r1 === sel.r0 : sel.c1 === sel.c0) return;
    const source = down ? { ...sel, r1: sel.r0 } : { ...sel, c1: sel.c0 };
    save(fill(data, source, sel));
  };

  // Pointer: press selects (drag selects a range with a mouse); the corner square fills.
  // Touch (14 Nov: "i can't able to multi select the cell touch hold drag"): a quick swipe still
  // scrolls the table, but a hold (350 ms) starts a range that follows the finger without
  // scrolling; the round handles on the range's corners stretch it afterwards.
  const drag = useRef<"select" | "fill" | "start" | "end" | null>(null);
  const press = useRef<{ id: number; x: number; y: number; timer: number; already: boolean; cell: Cell; held: boolean } | null>(null);
  // Mouse: a click on the cell that's already picked opens it for typing (like a second tap).
  const mouseAgain = useRef<Cell | null>(null);
  const [touchSel, setTouchSel] = useState(false);
  const capture = (id: number) => {
    try {
      grid.current?.setPointerCapture(id);
    } catch {
      // The finger is already up.
    }
  };
  const onCellDown = (e: React.PointerEvent, r: number, c: number) => {
    if (!editable) return;
    if (editing) commit(input.current?.value ?? editing.draft);
    const already = r === active.r && c === active.c && sel.r0 === sel.r1 && sel.c0 === sel.c1;
    if (e.shiftKey) setActive({ r, c });
    else {
      setActive({ r, c });
      setAnchor({ r, c });
    }
    if (e.pointerType === "mouse") {
      mouseAgain.current = already && !e.shiftKey ? { r, c } : null;
      drag.current = "select";
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      grid.current?.focus({ preventScroll: true });
      return;
    }
    if (press.current) window.clearTimeout(press.current.timer);
    const cell = { r, c };
    const timer = window.setTimeout(() => {
      if (!press.current) return;
      press.current.held = true;
      drag.current = "select";
      setAnchor(cell);
      setActive(cell);
      setTouchSel(true);
      navigator.vibrate?.(12);
      window.JournalHaptics?.play("press", 0.5);
      capture(press.current.id);
    }, HOLD_MS);
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer, already, cell, held: false };
    grid.current?.focus({ preventScroll: true });
  };
  /** A round handle on the range's corner: drag it to stretch the range. */
  const onHandleDown = (e: React.PointerEvent, which: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    // The other corner stays put.
    if (which === "start") {
      setAnchor({ r: sel.r1, c: sel.c1 });
      setActive({ r: sel.r0, c: sel.c0 });
    } else {
      setAnchor({ r: sel.r0, c: sel.c0 });
      setActive({ r: sel.r1, c: sel.c1 });
    }
    drag.current = which;
    capture(e.pointerId);
  };
  // While a touch range is being made, the table and the note don't scroll under the finger.
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const stop = (ev: TouchEvent) => {
      if (drag.current && ev.cancelable) ev.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, []);
  const onFillDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = "fill";
    setFillTo(sel);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = press.current;
    // Moved before the hold: it's a scroll, not a selection.
    if (p && !p.held && e.pointerId === p.id && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) {
      window.clearTimeout(p.timer);
      press.current = null;
    }
    if (!drag.current) return;
    const at = cellAt(e.clientX, e.clientY);
    if (!at) return;
    if (mouseAgain.current && (at.r !== mouseAgain.current.r || at.c !== mouseAgain.current.c)) mouseAgain.current = null;
    if (drag.current === "select" || drag.current === "start" || drag.current === "end") return void setActive(at);
    // Fill grows along the longer way out of the selection: down/up or across.
    const dr = at.r > sel.r1 ? at.r - sel.r1 : at.r < sel.r0 ? at.r - sel.r0 : 0;
    const dc = at.c > sel.c1 ? at.c - sel.c1 : at.c < sel.c0 ? at.c - sel.c0 : 0;
    if (Math.abs(dr) >= Math.abs(dc)) setFillTo({ ...sel, r0: Math.min(sel.r0, at.r), r1: Math.max(sel.r1, at.r) });
    else setFillTo({ ...sel, c0: Math.min(sel.c0, at.c), c1: Math.max(sel.c1, at.c) });
  };
  const onUp = () => {
    const p = press.current;
    if (p) {
      window.clearTimeout(p.timer);
      press.current = null;
      // 18 Nov ("click any cell in a table made by an agent and edit it"): one tap on a cell
      // opens it for typing (it took two, so a tap looked like it did nothing). A hold still
      // selects a range.
      if (!p.held && editable) {
        setTouchSel(false);
        setEditing({ draft: raw(p.cell.r, p.cell.c) });
      }
    }
    const again = mouseAgain.current;
    mouseAgain.current = null;
    if (again && drag.current === "select" && sel.r0 === sel.r1 && sel.c0 === sel.c1 && active.r === again.r && active.c === again.c) setEditing({ draft: raw(again.r, again.c) });
    if (drag.current === "fill" && fillTo && (fillTo.r0 !== sel.r0 || fillTo.r1 !== sel.r1 || fillTo.c0 !== sel.c0 || fillTo.c1 !== sel.c1)) {
      save(fill(data, sel, fillTo));
      setAnchor({ r: fillTo.r0, c: fillTo.c0 });
      setActive({ r: fillTo.r1, c: fillTo.c1 });
    }
    drag.current = null;
    setFillTo(null);
  };
  /** The browser took the touch over to scroll: nothing was tapped, so nothing opens. */
  const onCancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    mouseAgain.current = null;
    drag.current = null;
    setFillTo(null);
  };
  // Item 12 (18 Nov): a joystick for picking cells, apart from the fill square. Hold it and lean the
  // way to grow the selection from the picked cell: further = faster, a tick per cell.
  const [joy, setJoy] = useState<{ dx: number; dy: number } | null>(null);
  const joyRef = useRef<{ id: number; x0: number; y0: number; dx: number; dy: number; ax: number; ay: number; at: number; frame: number; r: number; c: number } | null>(null);
  const onJoyDown = (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    if (editing) commit(input.current?.value ?? editing.draft);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const j = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, ax: 0, ay: 0, at: performance.now(), frame: 0, r: active.r, c: active.c };
    joyRef.current = j;
    setTouchSel(true);
    setJoy({ dx: 0, dy: 0 });
    window.JournalHaptics?.play("press", 0.5);
    const step = (now: number) => {
      const k = joyRef.current;
      if (!k) return;
      const dt = Math.min(0.1, (now - k.at) / 1000);
      k.at = now;
      const go = (lean: number) => (Math.abs(lean) < 12 ? 0 : Math.sign(lean) * Math.min(14, 1.2 + Math.pow((Math.abs(lean) - 12) / 30, 1.6) * 2.4));
      k.ax += go(k.dx) * dt;
      k.ay += go(k.dy) * dt;
      let moved = false;
      while (Math.abs(k.ax) >= 1 || (k.ax !== 0 && Math.abs(k.ax) > 0.999)) {
        const s = Math.sign(k.ax);
        k.ax -= s;
        const nc = Math.min(data.cols - 1, Math.max(0, k.c + s));
        if (nc !== k.c) (k.c = nc), (moved = true);
      }
      while (Math.abs(k.ay) >= 1) {
        const s = Math.sign(k.ay);
        k.ay -= s;
        const nr = Math.min(data.rows - 1, Math.max(0, k.r + s));
        if (nr !== k.r) (k.r = nr), (moved = true);
      }
      if (moved) {
        setActive({ r: k.r, c: k.c });
        window.JournalHaptics?.play("tick", 0.4);
        grid.current?.querySelector<HTMLElement>(`[data-r="${k.r}"][data-c="${k.c}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      k.frame = requestAnimationFrame(step);
    };
    j.frame = requestAnimationFrame(step);
  };
  const onJoyMove = (e: React.PointerEvent) => {
    const k = joyRef.current;
    if (!k || k.id !== e.pointerId) return;
    const dx = Math.max(-60, Math.min(60, e.clientX - k.x0));
    const dy = Math.max(-60, Math.min(60, e.clientY - k.y0));
    k.dx = dx;
    k.dy = dy;
    // The first lean moves one cell at once (then the speed takes over).
    if (Math.abs(dx) > 12 && k.ax === 0) k.ax = Math.sign(dx) * 0.999;
    if (Math.abs(dy) > 12 && k.ay === 0) k.ay = Math.sign(dy) * 0.999;
    setJoy({ dx, dy });
  };
  const onJoyUp = () => {
    const k = joyRef.current;
    if (k) cancelAnimationFrame(k.frame);
    joyRef.current = null;
    setJoy(null);
  };
  useEffect(() => () => cancelAnimationFrame(joyRef.current?.frame ?? 0), []);

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

  /** Moves the active row or column (25 Nov); the selection goes with it. */
  const moveActive = (kind: "row" | "col", to: number) => {
    const from = kind === "row" ? active.r : active.c;
    const max = kind === "row" ? data.rows : data.cols;
    if (to < 0 || to >= max || to === from) return;
    save(moveLine(data, kind, from, to));
    const next = kind === "row" ? { r: to, c: active.c } : { r: active.r, c: to };
    setActive(next);
    setAnchor(next);
  };
  /** Drag a row number or column letter onto another to move it there. */
  const lineDrag = useRef<{ kind: "row" | "col"; from: number; to: number } | null>(null);
  const [dragLine, setDragLine] = useState<{ kind: "row" | "col"; from: number; to: number } | null>(null);
  const lineDown = (kind: "row" | "col", i: number) => (e: React.PointerEvent) => {
    if (!editable) return;
    e.stopPropagation();
    lineDrag.current = { kind, from: i, to: i };
    setDragLine(lineDrag.current);
    const onMoveL = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-line]");
      const d = lineDrag.current;
      if (!d || !el || el.dataset.line !== d.kind) return;
      const to = Number(el.dataset.i);
      if (to !== d.to) (lineDrag.current = { ...d, to }), setDragLine(lineDrag.current);
    };
    const onUpL = () => {
      window.removeEventListener("pointermove", onMoveL);
      window.removeEventListener("pointerup", onUpL);
      const d = lineDrag.current;
      lineDrag.current = null;
      setDragLine(null);
      if (d && d.to !== d.from) {
        save(moveLine(data, d.kind, d.from, d.to));
        const next = d.kind === "row" ? { r: d.to, c: active.c } : { r: active.r, c: d.to };
        setActive(next);
        setAnchor(next);
      }
    };
    window.addEventListener("pointermove", onMoveL);
    window.addEventListener("pointerup", onUpL);
  };

  const activeRaw = raw(active.r, active.c);
  const fillCorner = sel;
  return (
    <NodeViewWrapper className={`sheet-wrap${selected ? " is-selected" : ""}${plain ? " sheet-plain" : ""}`} contentEditable={false}>
      {/* Item 13 (18 Nov): only this title strip moves the table (held or dragged); holding a cell
          or the table body never picks the whole table up any more. */}
      <div className="sheet-title" data-drag-handle="" draggable title="Hold here to move the table">
        <span className="sheet-grip" aria-hidden>⠿</span>
        <span className="sheet-kind">{plain ? "☰ Table" : "▦ Sheet"}</span>
        <span className="sheet-title-space" />
        {editable && (
          <span className="sheet-mode" role="radiogroup" aria-label="Table kind" draggable={false} onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" role="radio" aria-checked={plain} className={plain ? "active" : ""} onClick={() => !plain && save({ ...data, mode: "table" })} title="A plain table for words and notes">☰ Normal</button>
            <button type="button" role="radio" aria-checked={!plain} className={!plain ? "active" : ""} onClick={() => { if (plain) { const { mode: _m, ...rest } = data; void _m; save(rest); } }} title="Excel: formulas and sums">▦ Excel</button>
          </span>
        )}
      </div>
      <div className="sheet-bar" draggable={false} onDragStart={(e) => e.preventDefault()}>
        <span className="sheet-ref">{sel.r0 === sel.r1 && sel.c0 === sel.c1 ? refName(active.r, active.c) : `${refName(sel.r0, sel.c0)}:${refName(sel.r1, sel.c1)}`}</span>
        <input
          className="sheet-formula"
          value={editing ? editing.draft : activeRaw}
          readOnly={!editable}
          placeholder={editable ? (plain ? "Type in the cell" : "Type a value or =SUM(A1:A3)") : ""}
          onFocus={() => editable && !editing && setEditing({ draft: activeRaw, bar: true })}
          onChange={(e) => setEditing({ draft: e.target.value, bar: true })}
          onKeyDown={onEditKey}
          onBlur={(e) => editing?.bar && commit(e.target.value)}
          aria-label="Cell contents"
          spellCheck={false}
        />
        {editable && touchSel && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1) && (
          <span className="sheet-tools sheet-range-tools">
            <button type="button" onClick={() => void copy()}>Copy</button>
            <button type="button" onClick={() => void copy().then(clearSelection)}>Cut</button>
            <button type="button" onClick={clearSelection}>Clear</button>
            <button type="button" onClick={() => void navigator.clipboard?.readText().then((t) => t && pasteText(t)).catch(() => {})}>Paste</button>
            {sel.r1 > sel.r0 && <button type="button" onClick={() => fillWithin(true)} title="Fill down from the first row">Fill ↓</button>}
            {sel.c1 > sel.c0 && <button type="button" onClick={() => fillWithin(false)} title="Fill right from the first column">Fill →</button>}
          </span>
        )}
        {editable && (
          <span
            className={`sheet-joy${joy ? " on" : ""}`}
            role="slider"
            aria-label="Select cells: hold and lean"
            aria-valuetext={sel.r0 === sel.r1 && sel.c0 === sel.c1 ? refName(active.r, active.c) : `${refName(sel.r0, sel.c0)}:${refName(sel.r1, sel.c1)}`}
            title="Hold and lean to select cells"
            onPointerDown={onJoyDown}
            onPointerMove={onJoyMove}
            onPointerUp={onJoyUp}
            onPointerCancel={onJoyUp}
          >
            <i style={joy ? { transform: `translate(${joy.dx * 0.25}px, ${joy.dy * 0.25}px)` } : undefined} />
          </span>
        )}
        {editable && (
          <span className="sheet-tools">
            <button type="button" onClick={addRow} title="Add a row">+ Row</button>
            <button type="button" onClick={addCol} title="Add a column">+ Col</button>
            <button type="button" onClick={() => removeLine("row")} title={`Delete row ${active.r + 1}`}>− Row</button>
            <button type="button" onClick={() => removeLine("col")} title={`Delete column ${colName(active.c)}`}>− Col</button>
            <button type="button" onClick={() => moveActive("row", active.r - 1)} disabled={active.r <= 0} title="Move this row up">↑</button>
            <button type="button" onClick={() => moveActive("row", active.r + 1)} disabled={active.r >= data.rows - 1} title="Move this row down">↓</button>
            <button type="button" onClick={() => moveActive("col", active.c - 1)} disabled={active.c <= 0} title="Move this column left">←</button>
            <button type="button" onClick={() => moveActive("col", active.c + 1)} disabled={active.c >= data.cols - 1} title="Move this column right">→</button>
          </span>
        )}
      </div>
      <div className="sheet-grid" ref={grid} tabIndex={0} draggable={false} onDragStart={(e) => (e.preventDefault(), e.stopPropagation())} onContextMenu={(e) => e.preventDefault()} onKeyDown={onKeyDown} onPaste={onPaste} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} role="grid" aria-label="Spreadsheet">
        <table>
          <thead>
            <tr>
              <th className="sheet-corner" />
              {Array.from({ length: shownCols }, (_, c) => (
                <th key={c} data-line="col" data-i={c} onPointerDown={lineDown("col", c)} className={`${c >= sel.c0 && c <= sel.c1 ? "on" : ""}${dragLine?.kind === "col" && dragLine.to === c ? " drop" : ""}${dragLine?.kind === "col" && dragLine.from === c ? " lifting" : ""}`} style={data.widths?.[c] ? { width: data.widths[c], minWidth: data.widths[c] } : undefined}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: shownRows }, (_, r) => (
              <tr key={r}>
                <th data-line="row" data-i={r} onPointerDown={lineDown("row", r)} className={`${r >= sel.r0 && r <= sel.r1 ? "on" : ""}${dragLine?.kind === "row" && dragLine.to === r ? " drop" : ""}${dragLine?.kind === "row" && dragLine.from === r ? " lifting" : ""}`}>{r + 1}</th>
                {Array.from({ length: shownCols }, (_, c) => {
                  const key = refName(r, c);
                  const v = values.get(key);
                  const isActive = r === active.r && c === active.c;
                  const cls = [
                    inRange(sel, r, c) && "sel",
                    isActive && "active",
                    fillTo && inRange(fillTo, r, c) && !inRange(sel, r, c) && "filling",
                    !plain && typeof v === "number" && "num",
                    !plain && isError(v) && "err",
                    !plain && data.cells[key]?.startsWith("=") && "fx",
                    plain && r === 0 && "head",
                  ].filter(Boolean).join(" ");
                  return (
                    <td key={c} data-r={r} data-c={c} className={cls} onPointerDown={(e) => onCellDown(e, r, c)} onDoubleClick={() => editable && setEditing({ draft: raw(r, c) })} role="gridcell" aria-selected={inRange(sel, r, c)}>
                      {isActive && editing && !editing.bar ? (
                        <input ref={input} className="sheet-edit" value={editing.draft} onChange={(e) => setEditing({ draft: e.target.value })} onKeyDown={onEditKey} onBlur={(e) => commit(e.target.value)} spellCheck={false} />
                      ) : (
                        plain ? (v as string | undefined) ?? "" : display(v)
                      )}
                      {editable && !plain && !editing && !fillTo && r === fillCorner.r1 && c === fillCorner.c1 && !touchSel && <i className="sheet-fill" onPointerDown={onFillDown} title="Drag to fill" />}
                      {editable && !editing && touchSel && r === sel.r0 && c === sel.c0 && <i className="sheet-handle start" onPointerDown={(e) => onHandleDown(e, "start")} aria-label="Stretch the selection" />}
                      {editable && !editing && touchSel && r === sel.r1 && c === sel.c1 && <i className="sheet-handle end" onPointerDown={(e) => onHandleDown(e, "end")} aria-label="Stretch the selection" />}
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
/** A plain bordered table (no letters, numbers or formulas round it). */
export const newTableContent = () => ({ type: "sheetBlock", attrs: { data: JSON.stringify({ ...emptySheet(3, 3), mode: "table" }) } });
