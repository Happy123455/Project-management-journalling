import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Editor } from "@tiptap/react";
import type { Command } from "@tiptap/pm/state";
import { blockIndexAt, blockPos, blockRange, deleteBlock, duplicateBlock, insertLine, moveBlock, moveBlockTo, toggleCollapsed } from "./blocks";

const TEXT_TYPES = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock"]);

/** The ⋮⋮ handle beside a block: drag it to move the block, tap it for the block menu. */
export function BlockHandle({ editor, touch, onInfo }: { editor: Editor; touch: boolean; onInfo: () => void }) {
  const [index, setIndex] = useState<number | null>(null);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dropY, setDropY] = useState<number | null>(null);
  const host = useRef<HTMLElement | null>(null);
  const drag = useRef<{ startY: number; moved: boolean; target: number | null } | null>(null);

  const domOf = useCallback(
    (i: number) => editor.view.nodeDOM(blockPos(editor.state.doc, i)) as HTMLElement | null,
    [editor],
  );
  const place = useCallback(
    (i: number | null) => {
      const container = host.current;
      const dom = i === null ? null : domOf(i);
      if (i === null || !dom || !container || i >= editor.state.doc.childCount) {
        setIndex(null);
        setBox(null);
        return;
      }
      const r = dom.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      setIndex(i);
      setBox({ top: r.top - c.top, height: Math.min(r.height, 40) || 24 });
    },
    [domOf, editor],
  );

  // Which block: the one under the mouse (Mac), or the one with the cursor (phone).
  useEffect(() => {
    host.current = editor.view.dom.closest(".editor");
    const fromSelection = () => {
      if (drag.current || menu) return;
      if (touch && !editor.isFocused) return place(null);
      if (touch || !host.current?.matches(":hover")) place(blockIndexAt(editor.state.doc, editor.state.selection.from));
    };
    const onMove = (e: MouseEvent) => {
      if (drag.current || menu || touch) return;
      const doc = editor.state.doc;
      for (let i = 0; i < doc.childCount; i++) {
        const r = domOf(i)?.getBoundingClientRect();
        if (r && r.height && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4) return place(i);
      }
    };
    editor.on("selectionUpdate", fromSelection);
    editor.on("update", fromSelection);
    editor.on("focus", fromSelection);
    editor.on("blur", fromSelection);
    host.current?.addEventListener("mousemove", onMove);
    const h = host.current;
    return () => {
      editor.off("selectionUpdate", fromSelection);
      editor.off("update", fromSelection);
      editor.off("focus", fromSelection);
      editor.off("blur", fromSelection);
      h?.removeEventListener("mousemove", onMove);
    };
  }, [editor, touch, menu, place, domOf]);

  // Keep it beside its block as the note changes size.
  useLayoutEffect(() => {
    if (index !== null && !drag.current) place(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.state.doc]);

  const run = (command: Command) => {
    command(editor.state, editor.view.dispatch);
    editor.commands.focus();
  };

  /** The index a block dropped at clientY would land at, and where to draw the line. */
  const dropAt = (clientY: number) => {
    const doc = editor.state.doc;
    const c = host.current!.getBoundingClientRect();
    let last = 0;
    for (let i = 0; i < doc.childCount; i++) {
      const r = domOf(i)?.getBoundingClientRect();
      if (!r || !r.height) continue;
      if (clientY < r.top + r.height / 2) return { target: i, y: r.top - c.top - 2 };
      last = r.bottom - c.top;
    }
    return { target: doc.childCount, y: last + 2 };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    if (index === null) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, moved: false, target: null };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.startY) < 6) return;
    d.moved = true;
    const at = dropAt(e.clientY);
    d.target = at.target;
    setDropY(at.y);
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDropY(null);
    if (!d || index === null) return;
    if (d.moved) {
      if (d.target !== null) run(moveBlockTo(index, d.target));
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right + 6, y: r.top });
  };

  if (index === null || !box) return null;
  const doc = editor.state.doc;
  if (index >= doc.childCount) return null;
  const node = doc.child(index);
  const hasChildren = blockRange(doc, index).end > index + 1;
  const isText = TEXT_TYPES.has(node.type.name);

  /** Puts the cursor in the block first, for commands that act on the selection. */
  const inBlock = () => editor.chain().focus().setTextSelection(blockPos(doc, index) + (node.isTextblock ? 1 : 2));
  const turnInto: [string, string, () => void][] = [
    ["¶", "Text", () => inBlock().clearNodes().run()],
    ["H", "Heading", () => inBlock().clearNodes().setHeading({ level: 2 }).run()],
    ["•", "Bullets", () => inBlock().clearNodes().toggleBulletList().run()],
    ["☑", "Tasks", () => inBlock().clearNodes().toggleTaskList().run()],
    ["1.", "Numbered", () => inBlock().clearNodes().toggleOrderedList().run()],
    ["❝", "Quote", () => inBlock().clearNodes().toggleBlockquote().run()],
    ["</>", "Code", () => inBlock().clearNodes().toggleCodeBlock().run()],
  ];
  const actions: [string, string, () => void][] = [
    ["↥", "Add line above", () => run(insertLine(index, "above"))],
    ["↧", "Add line below", () => run(insertLine(index, "below"))],
    ["⧉", "Duplicate", () => run(duplicateBlock(index))],
    ["↑", "Move up", () => run(moveBlock(index, -1))],
    ["↓", "Move down", () => run(moveBlock(index, 1))],
    ...(isText ? ([["ⓘ", "Info", () => (inBlock().run(), onInfo())]] as [string, string, () => void][]) : []),
    ["🗑", "Delete", () => run(deleteBlock(index))],
  ];

  // The menu stays inside the screen, whichever block it opened from.
  const menuStyle = menu
    ? {
        left: Math.max(8, Math.min(menu.x, window.innerWidth - 228)),
        top: Math.max(8, Math.min(menu.y, (window.visualViewport?.height ?? window.innerHeight) - 380)),
      }
    : undefined;

  return (
    <>
      <div className="block-handle" style={{ top: box.top, height: box.height }} contentEditable={false}>
        {hasChildren && (
          <button
            type="button"
            className="block-caret"
            aria-label={node.attrs.collapsed ? "Expand" : "Collapse"}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => run(toggleCollapsed(index))}
          >
            {node.attrs.collapsed ? "▸" : "▾"}
          </button>
        )}
        <button
          type="button"
          className="block-grip"
          aria-label="Move or change this block"
          title="Drag to move, click for options"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => ((drag.current = null), setDropY(null))}
        >
          ⋮⋮
        </button>
      </div>
      {dropY !== null && <div className="block-drop-line" style={{ top: dropY }} />}
      {menu && (
        <>
          <div className="block-menu-backdrop" onPointerDown={(e) => (e.preventDefault(), setMenu(null))} />
          <div className="block-menu" role="menu" style={menuStyle} onPointerDown={(e) => e.preventDefault()}>
            {isText && (
              <>
                <div className="block-menu-label">Turn into</div>
                <div className="block-menu-grid">
                  {turnInto.map(([icon, label, act]) => (
                    <button key={label} type="button" role="menuitem" title={label} onClick={() => (setMenu(null), act())}>
                      <span>{icon}</span>
                      <small>{label}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
            {actions.map(([icon, label, act]) => (
              <button key={label} type="button" role="menuitem" className={label === "Delete" ? "danger" : ""} onClick={() => (setMenu(null), act())}>
                <span className="block-menu-icon">{icon}</span>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
