import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatTimestamp } from "../lib/timestamp";
import { sourceStats } from "../lib/source";
import { noteTyped } from "./typingGuide";
import { useBarShown } from "./KeyboardBar";

/**
 * Source mode: the note as plain characters in one text box (Markdown, like Obsidian's source
 * mode). Nothing is drawn: photos are their ![[…]] embeds, links keep their [[ ]], timestamps are
 * text. Lists continue on Enter, Tab nests, and on the phone a bar above the keyboard types the
 * marks that are awkward to reach.
 */
export function SourceEditor({ value, onChange, touch, autofocus }: { value: string; onChange: (text: string) => void; touch: boolean; autofocus?: boolean }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const [mono, setMono] = useState(() => {
    try {
      return localStorage.getItem("journal.sourceMono") === "1";
    } catch {
      return false;
    }
  });

  // Grows with its text, so the page scrolls as one (no box scrolling inside the page).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 4}px`;
  }, [text, mono]);
  useEffect(() => {
    if (autofocus) box.current?.focus({ preventScroll: true });
  }, [autofocus]);

  const changed = (next: string) => {
    setText(next);
    onChange(next);
  };

  /** Types at the cursor the way a keyboard would (the text box's own undo keeps working). */
  const type = (insert: string, select?: [number, number]) => {
    const el = box.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const ok = document.execCommand?.("insertText", false, insert);
    if (!ok) {
      el.setRangeText(insert, el.selectionStart, el.selectionEnd, "end");
      changed(el.value);
    }
    if (select) el.setSelectionRange(select[0], select[1]);
  };
  /** Puts marks around the selection (or the cursor). */
  const wrap = (left: string, right = left) => {
    const el = box.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const inner = el.value.slice(a, b);
    type(left + inner + right, inner ? undefined : [a + left.length, a + left.length]);
  };
  /** The start and end of the lines the selection touches. */
  const lineRange = () => {
    const el = box.current!;
    const v = el.value;
    const start = v.lastIndexOf("\n", el.selectionStart - 1) + 1;
    let end = v.indexOf("\n", el.selectionEnd);
    if (end < 0) end = v.length;
    return { start, end };
  };
  /** Adds or takes away a tab at the start of each selected line. */
  const indent = (dir: 1 | -1) => {
    const el = box.current;
    if (!el) return;
    const { start, end } = lineRange();
    const lines = el.value.slice(start, end).split("\n");
    const next = lines.map((l) => (dir > 0 ? `\t${l}` : l.replace(/^\t/, ""))).join("\n");
    const caret = el.selectionStart;
    el.setSelectionRange(start, end);
    type(next);
    const moved = dir > 0 ? 1 : lines[0].startsWith("\t") ? -1 : 0;
    el.setSelectionRange(Math.max(start, caret + moved), Math.max(start, caret + moved));
  };
  /** Starts the current line with a prefix (or takes it away when it's already there). */
  const linePrefix = (prefix: string) => {
    const el = box.current;
    if (!el) return;
    const { start } = lineRange();
    const lead = /^\t*/.exec(el.value.slice(start))![0].length;
    const at = start + lead;
    const has = el.value.startsWith(prefix, at);
    const caret = el.selectionStart;
    el.setSelectionRange(at, at + (has ? prefix.length : 0));
    type(has ? "" : prefix);
    const c = caret + (has ? -prefix.length : prefix.length);
    el.setSelectionRange(Math.max(at, c), Math.max(at, c));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Tab") {
      e.preventDefault();
      indent(e.shiftKey ? -1 : 1);
      return;
    }
    if (mod && e.key.toLowerCase() === "b") return void (e.preventDefault(), wrap("**"));
    if (mod && e.key.toLowerCase() === "i") return void (e.preventDefault(), wrap("*"));
    if (mod && e.shiftKey && e.key.toLowerCase() === "h") return void (e.preventDefault(), wrap("=="));
    if (e.key === "Enter" && !e.shiftKey && el.selectionStart === el.selectionEnd) {
      // Lists and quotes carry on to the next line; Enter on an empty item ends the list.
      const v = el.value;
      const start = v.lastIndexOf("\n", el.selectionStart - 1) + 1;
      const line = v.slice(start, el.selectionStart);
      const m = /^(\t*)(- \[[ xX]\] |- |\+ |(\d+)([.)]) |> )/.exec(line);
      if (!m) return;
      e.preventDefault();
      if (line === m[0]) {
        el.setSelectionRange(start, el.selectionStart);
        type("");
        return;
      }
      const marker = m[3] ? `${Number(m[3]) + 1}${m[4]} ` : m[2].startsWith("- [") ? "- [ ] " : m[2];
      type(`\n${m[1]}${marker}`);
    }
  };

  const stats = sourceStats(text);
  const tools: [string, string, () => void][] = [
    ["⇥", "Nest (Tab)", () => indent(1)],
    ["⇤", "Un-nest (Shift+Tab)", () => indent(-1)],
    ["B", "Bold", () => wrap("**")],
    ["I", "Italic", () => wrap("*")],
    ["H", "Highlight", () => wrap("==")],
    ["[[ ]]", "Link a page", () => wrap("[[", "]]")],
    ["#", "Heading", () => linePrefix("## ")],
    ["•", "Bullet", () => linePrefix("- ")],
    ["☑", "Task", () => linePrefix("- [ ] ")],
    ["❝", "Quote", () => linePrefix("> ")],
    ["</>", "Code block", () => wrap("```\n", "\n```")],
    ["`", "Inline code", () => wrap("`")],
    ["🕒", "Timestamp", () => type(formatTimestamp(new Date()) + " ")],
    ["↶", "Undo", () => (box.current?.focus(), document.execCommand?.("undo"))],
    ["↷", "Redo", () => (box.current?.focus(), document.execCommand?.("redo"))],
    ["Aa", "Monospace font", () => setMono((m) => (localStorage.setItem("journal.sourceMono", m ? "0" : "1"), !m))],
  ];
  const bar = (
    <div className="source-tools" role="toolbar" aria-label="Source mode tools" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      {tools.map(([label, title, run]) => (
        <button key={title} type="button" className="tool" title={title} aria-label={title} onClick={run}>
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div className="source-mode">
      {!touch && bar}
      <textarea
        ref={box}
        className={`source-text${mono ? " mono" : ""}`}
        value={text}
        spellCheck
        autoCapitalize="sentences"
        onChange={(e) => {
          noteTyped(e.target.value.length - text.length);
          changed(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label="Note source"
      />
      <p className="source-stats">
        Source · {stats.words} words · {stats.chars} characters · {stats.lines} lines
      </p>
      {touch && focused && createPortal(<SourceKeyboardBar>{bar}</SourceKeyboardBar>, document.body)}
    </div>
  );
}

/** The note bar's row setting (Arrange tools), so Source mode's bar is laid out the same way. */
function barLayoutClass(): string {
  try {
    const v = JSON.parse(localStorage.getItem("dynamic-journal.toolbar") ?? "{}");
    return `${v.rows === 2 ? " rows-2" : ""}${v.big ? " big" : ""}`;
  } catch {
    return "";
  }
}

/** The phone's tool rows, pinned above the keyboard (up and down like the note's bar, never sideways). */
function SourceKeyboardBar({ children }: { children: React.ReactNode }) {
  useBarShown(true);
  const [bottom, setBottom] = useState(() => (window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight));
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBottom(vv.offsetTop + vv.height);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return (
    <div className={`keyboard-bar source-bar${barLayoutClass()}`} style={{ top: `${bottom}px` }}>
      {children}
    </div>
  );
}
