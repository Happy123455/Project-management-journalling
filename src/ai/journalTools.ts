// The journal's tools in one place, for every AI that can use them: the Mac's local model (Qwen's
// <tool_call> format, src/ai/agent.ts), Gemini (function calling, src/ai/geminiTools.ts) and MCP
// clients like Claude Desktop (src-tauri/src/mcp.rs → src/mcp.ts). Each tool is described once here;
// src/mcp.ts runs them. Writes go through the store under the AI's name (undo in Settings → AI changes).
import type { JSONContent } from "@tiptap/core";
import type { JournalStore } from "../store";
import { appendBlocks } from "../lib/append";
import { parseRule, RULES_PAGE } from "../lib/aiRules";
import { emptySheet, parseSheet, setCells, sheetForAi, type SheetData } from "../lib/sheet";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  /** read: looks only; write: changes notes; nav: changes what's on screen. */
  kind: "read" | "write" | "nav";
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const DATE = { type: "string", description: "YYYY-MM-DD" };
const TITLE = { type: "string", description: "page title instead of a date" };
const SHEET = { type: "integer", description: "which table in the note, 1 = the first (default 1)" };

export const TOOL_SPECS: ToolSpec[] = [
  // Reading
  { kind: "read", name: "today", description: "Read today's note.", parameters: obj({}) },
  { kind: "read", name: "read_day", description: "Read the note of one day.", parameters: obj({ date: DATE }, ["date"]) },
  { kind: "read", name: "read_page", description: "Read a named page (a project, person, topic).", parameters: obj({ title: { type: "string" } }, ["title"]) },
  { kind: "read", name: "search", description: "Find days and pages containing all these words.", parameters: obj({ query: { type: "string" } }, ["query"]) },
  { kind: "read", name: "list_days", description: "List every day that has a note.", parameters: obj({}) },
  { kind: "read", name: "list_projects", description: "List the projects (title and status).", parameters: obj({}) },
  { kind: "read", name: "read_sheet", description: "Read a spreadsheet table in a note: each cell with what's typed and, for formulas, the result.", parameters: obj({ date: DATE, title: TITLE, sheet: SHEET }) },
  // Writing
  { kind: "write", name: "append", description: "Add text at the end of a day's note (today if no date). One paragraph per line; [[Page]] links and #tags work.", parameters: obj({ text: { type: "string" }, date: DATE }, ["text"]) },
  { kind: "write", name: "replace_text", description: "In a day's note or a page, replace `find` (first line that has it) with `replace` (empty deletes).", parameters: obj({ find: { type: "string" }, replace: { type: "string" }, date: DATE, title: TITLE }, ["find", "replace"]) },
  { kind: "write", name: "add_to_page", description: "Add text at the end of a named page, creating it if needed.", parameters: obj({ title: { type: "string" }, text: { type: "string" } }, ["title", "text"]) },
  {
    kind: "write",
    name: "set_cells",
    description: 'Fill or change cells of a spreadsheet table in a note (A1 style). A value starting with = is a formula, e.g. "=SUM(B2:B9)", "=IF(C2>100,\\"over\\",\\"ok\\")", "=AVERAGE(A1:A5)". An empty value clears the cell. The table grows when needed.',
    parameters: obj(
      {
        date: DATE,
        title: TITLE,
        sheet: SHEET,
        cells: { type: "array", description: "the cells to set", items: { type: "object", properties: { ref: { type: "string", description: "A1" }, value: { type: "string" } }, required: ["ref", "value"] } },
      },
      ["cells"],
    ),
  },
  {
    kind: "write",
    name: "add_sheet",
    description: "Add a new spreadsheet table at the end of a note (today if no date), optionally filled with cells.",
    parameters: obj({ date: DATE, title: TITLE, rows: { type: "integer" }, cols: { type: "integer" }, cells: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] } } }),
  },
  { kind: "write", name: "add_rule", description: 'Add a navigation rule to the "AI rules" page, e.g. "weekdays 09:00 open [[Work log]]", "on open → today", "sat 10:30 → [[Weekend plans]]".', parameters: obj({ rule: { type: "string" } }, ["rule"]) },
  { kind: "write", name: "save_graph", description: "Save a mind-map graph (JSON with features, prompts and segs) as a Canvas graph.", parameters: obj({ title: { type: "string" }, data: { type: "string" } }, ["title", "data"]) },
  // On screen
  { kind: "nav", name: "open_note", description: "Open a note on screen now: a day (YYYY-MM-DD, or today/yesterday/tomorrow) or a page or project title. It must exist.", parameters: obj({ target: { type: "string" } }, ["target"]) },
];

export const specsOf = (...kinds: ToolSpec["kind"][]) => TOOL_SPECS.filter((t) => kinds.includes(t.kind));

/** The open_note event: App.tsx opens the day or page. */
export const AI_OPEN_EVENT = "journal:ai-open";

// ───── Tables inside notes ─────

interface NoteRef {
  name: string;
  doc: JSONContent | null;
  save: (doc: JSONContent, actor: string) => Promise<unknown>;
}

async function noteFor(store: JournalStore, args: Record<string, unknown>, now: Date, create = false): Promise<NoteRef | string> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title) {
    const page = create ? await store.ensurePage(title) : await store.getPage(title);
    if (!page) return `No page called "${title}".`;
    return { name: page.title, doc: page.content, save: (doc, actor) => store.savePage({ id: page.id, content: doc, plainText: docText(doc), actor }) };
  }
  const day = typeof args.date === "string" && args.date ? args.date : dayKey(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "date must be YYYY-MM-DD";
  const page = await store.getDay(day);
  return { name: day, doc: page?.content ?? null, save: (doc, actor) => store.saveDay({ day, content: doc, plainText: docText(doc), actor }) };
}

/** The tables in a document, in order, with a way to put a changed one back. */
function sheetsIn(doc: JSONContent | null): { data: SheetData; put: (d: SheetData) => JSONContent }[] {
  const out: { data: SheetData; put: (d: SheetData) => JSONContent }[] = [];
  if (!doc) return out;
  const visit = (node: JSONContent, path: number[]) => {
    if (node.type === "sheetBlock") {
      out.push({
        data: parseSheet(node.attrs?.data),
        put: (d) => replaceAt(doc, path, { ...node, attrs: { ...node.attrs, data: JSON.stringify(d) } }),
      });
      return;
    }
    (node.content ?? []).forEach((c, i) => visit(c, [...path, i]));
  };
  visit(doc, []);
  return out;
}

function replaceAt(node: JSONContent, path: number[], next: JSONContent): JSONContent {
  if (!path.length) return next;
  const [i, ...rest] = path;
  const content = [...(node.content ?? [])];
  content[i] = replaceAt(content[i], rest, next);
  return { ...node, content };
}

/** {"A1": "x"} or [{ref, value}] → {"A1": "x"} */
function cellPatch(cells: unknown): Record<string, unknown> | string {
  if (Array.isArray(cells)) {
    const out: Record<string, unknown> = {};
    for (const c of cells) {
      if (!c || typeof c !== "object" || typeof (c as { ref?: unknown }).ref !== "string") return 'Each cell needs {"ref": "A1", "value": "…"}.';
      out[(c as { ref: string }).ref] = (c as { value?: unknown }).value ?? "";
    }
    return out;
  }
  if (cells && typeof cells === "object") return cells as Record<string, unknown>;
  if (typeof cells === "string") {
    try {
      return cellPatch(JSON.parse(cells));
    } catch {
      return "cells must be a list of {ref, value}.";
    }
  }
  return "cells must be a list of {ref, value}.";
}

export interface ToolOut {
  text: string;
  error?: boolean;
}
const ok = (text: string): ToolOut => ({ text });
const bad = (text: string): ToolOut => ({ text, error: true });

/** The tools that are new with the shared layer (the others are in src/mcp.ts). Null: not one of these. */
export async function runJournalTool(store: JournalStore, name: string, args: Record<string, unknown>, actor: string, now = new Date()): Promise<ToolOut | null> {
  switch (name) {
    case "list_projects": {
      const list = await store.projects();
      if (!list.length) return ok("No projects yet.");
      return ok(list.map((p) => `- ${p.title}${p.props.project?.status ? ` (${p.props.project.status})` : ""}`).join("\n"));
    }
    case "read_sheet": {
      const note = await noteFor(store, args, now);
      if (typeof note === "string") return bad(note);
      const sheets = sheetsIn(note.doc);
      if (!sheets.length) return bad(`There's no table in ${note.name}. add_sheet makes one.`);
      const which = Number(args.sheet ?? 0);
      if (which) {
        const s = sheets[which - 1];
        return s ? ok(`# ${note.name}, table ${which}\n${sheetForAi(s.data)}`) : bad(`${note.name} has ${sheets.length} table${sheets.length === 1 ? "" : "s"}.`);
      }
      return ok(sheets.map((s, i) => `# ${note.name}, table ${i + 1}\n${sheetForAi(s.data)}`).join("\n\n"));
    }
    case "set_cells": {
      const patch = cellPatch(args.cells);
      if (typeof patch === "string") return bad(patch);
      await window.__journalFlush?.();
      const note = await noteFor(store, args, now);
      if (typeof note === "string") return bad(note);
      const sheets = sheetsIn(note.doc);
      const which = Number(args.sheet ?? 1) || 1;
      const s = sheets[which - 1];
      if (!s) return bad(sheets.length ? `${note.name} has ${sheets.length} table${sheets.length === 1 ? "" : "s"}.` : `There's no table in ${note.name}. add_sheet makes one.`);
      const next = setCells(s.data, patch);
      if (typeof next === "string") return bad(next);
      await note.save(s.put(next), actor);
      window.dispatchEvent(new Event("journal:reload-page"));
      return ok(`Done. ${note.name}, table ${which} now:\n${sheetForAi(next)}`);
    }
    case "add_sheet": {
      await window.__journalFlush?.();
      const note = await noteFor(store, args, now, true);
      if (typeof note === "string") return bad(note);
      let data = emptySheet(Math.min(200, Math.max(1, Number(args.rows) || 5)), Math.min(26, Math.max(1, Number(args.cols) || 4)));
      if (args.cells !== undefined) {
        const patch = cellPatch(args.cells);
        if (typeof patch === "string") return bad(patch);
        const next = setCells(data, patch);
        if (typeof next === "string") return bad(next);
        data = next;
      }
      const doc = appendBlocks(note.doc, [{ type: "sheetBlock", attrs: { data: JSON.stringify(data) } }]);
      await note.save(doc, actor);
      window.dispatchEvent(new Event("journal:reload-page"));
      return ok(`Added table ${sheetsIn(doc).length} to ${note.name}:\n${sheetForAi(data)}`);
    }
    case "add_rule": {
      const line = String(args.rule ?? "").trim();
      const rule = parseRule(line);
      if (!rule) return bad('That isn\'t a rule I can follow. Write it like "weekdays 09:00 open [[Work log]]", "on open → today" or "sat, sun 10:30 → [[Weekend plans]]".');
      await window.__journalFlush?.();
      const page = await store.ensurePage(RULES_PAGE, actor);
      const doc = appendBlocks(page.content ?? null, [{ type: "paragraph", content: [{ type: "text", text: rule.line }] }]);
      await store.savePage({ id: page.id, content: doc, plainText: docText(doc), actor });
      window.dispatchEvent(new Event("journal:rules-changed"));
      return ok(`Added to ${RULES_PAGE}: ${rule.line}`);
    }
    case "open_note": {
      const target = String(args.target ?? "").trim();
      if (!target) return bad("target is empty");
      const rel = /^(today|yesterday|tomorrow)$/i.test(target);
      const day = rel ? null : /^\d{4}-\d{2}-\d{2}$/.test(target) ? target : null;
      if (!rel && !day) {
        const page = await store.getPage(target);
        if (!page) {
          const names = (await store.pageNames()).filter((n) => n.toLowerCase().includes(target.toLowerCase())).slice(0, 8);
          return bad(`No page called "${target}".${names.length ? ` Did you mean: ${names.join(", ")}?` : ""}`);
        }
      }
      window.dispatchEvent(new CustomEvent(AI_OPEN_EVENT, { detail: { target } }));
      return ok(`Opened ${target}.`);
    }
    default:
      return null;
  }
}
