import { runMcpTool } from "../mcp";
import type { JournalStore } from "../store";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import type { LocalMessage } from "./local";
import { applyBlockOp, numbered, type BlockOp, type Section, type Target } from "./blocks";

/**
 * The journal tools the local model may call when "Can edit" is on in AI chat. Reads and whole-note
 * writes are the MCP tools (src/mcp.ts); block tools edit one numbered block. Every write is an
 * event under the model's name and can be undone in Settings → AI changes. With a section picked,
 * only the block tools on that section are offered, and anything else is refused here.
 * Qwen's own tool format: <tool_call>{"name", "arguments"}</tool_call>.
 */
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const DATE = { type: "string", description: "YYYY-MM-DD" };
const TITLE = { type: "string", description: "page title instead of a date" };

const READ_TOOLS = [
  { name: "today", description: "Read today's note.", parameters: obj({}) },
  { name: "read_day", description: "Read the note of one day.", parameters: obj({ date: DATE }, ["date"]) },
  { name: "read_page", description: "Read a named page (a project, person, topic).", parameters: obj({ title: { type: "string" } }, ["title"]) },
  { name: "search", description: "Find days and pages containing all these words.", parameters: obj({ query: { type: "string" } }, ["query"]) },
  { name: "list_days", description: "List every day that has a note.", parameters: obj({}) },
];
const NOTE_TOOLS = [
  { name: "append", description: "Add text at the end of a day's note (today if no date). One paragraph per line; [[Page]] links and #tags work.", parameters: obj({ text: { type: "string" }, date: DATE }, ["text"]) },
  { name: "replace_text", description: "In a day's note or a page, replace `find` (first line that has it) with `replace` (empty deletes).", parameters: obj({ find: { type: "string" }, replace: { type: "string" }, date: DATE, title: TITLE }, ["find", "replace"]) },
  { name: "add_to_page", description: "Add text at the end of a named page, creating it if needed.", parameters: obj({ title: { type: "string" }, text: { type: "string" } }, ["title", "text"]) },
];
const where = (section: boolean) => (section ? {} : { date: DATE, title: TITLE });
const blockTools = (section: boolean) => [
  { name: "read_blocks", description: section ? "Read the section you may edit, as numbered blocks." : "Read a note (today if no date) as numbered blocks, to edit one by its number.", parameters: obj(where(section)) },
  { name: "replace_block", description: "Replace block n with text (several lines make several blocks; '# ' makes a heading).", parameters: obj({ n: { type: "integer" }, text: { type: "string" }, ...where(section) }, ["n", "text"]) },
  { name: "insert_after", description: "Insert text after block n (0 = before the first).", parameters: obj({ n: { type: "integer" }, text: { type: "string" }, ...where(section) }, ["n", "text"]) },
  { name: "delete_block", description: "Delete block n.", parameters: obj({ n: { type: "integer" }, ...where(section) }, ["n"]) },
];

export function agentSystem(section?: Section | null, now = new Date()): string {
  const tools = section ? [...READ_TOOLS, ...blockTools(true)] : [...READ_TOOLS, ...blockTools(false), ...NOTE_TOOLS];
  const scope = section
    ? `You may change only one section the user picked (${section.label}); call read_blocks first. Everything else is read-only. `
    : "Edit only what the user asks for; read the note first (read_blocks) when you change existing text. ";
  return (
    `You can read and edit the user's journal with tools. Today is ${dayKey(now)}. ${scope}` +
    "If a tool answers with an error, fix the call and try again. Afterwards tell the user briefly what you changed.\n\n" +
    "# Tools\n\nYou may call one or more functions to assist with the user query.\n\n" +
    "You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n" +
    tools.map((t) => JSON.stringify({ type: "function", function: t })).join("\n") +
    "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n" +
    '<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
  );
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** The call couldn't be read: told back to the model. */
  error?: string;
}

/** The tool calls in an answer, and the answer without them. */
export function parseToolCalls(answer: string): { calls: ToolCall[]; text: string } {
  const calls: ToolCall[] = [];
  const text = answer
    .replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, json: string) => {
      try {
        const c = JSON.parse(json);
        if (c && typeof c.name === "string") calls.push({ name: c.name, arguments: c.arguments ?? {} });
        else calls.push({ name: "?", arguments: {}, error: 'A tool call needs {"name": ..., "arguments": {...}}.' });
      } catch {
        calls.push({ name: "?", arguments: {}, error: `That tool call wasn't valid JSON: ${json.slice(0, 200)}` });
      }
      return "";
    })
    .trim();
  return { calls, text };
}

/** Reads and writes the note a block tool points at. */
async function note(store: JournalStore, t: Target, now: Date) {
  if (t.title) {
    const page = await store.getPage(t.title);
    if (!page) return null;
    return { name: page.title, doc: page.content, save: (doc: typeof page.content, actor: string) => store.savePage({ id: page.id, content: doc, plainText: docText(doc), actor }) };
  }
  const day = t.day || dayKey(now);
  const page = await store.getDay(day);
  return { name: day, doc: page?.content ?? null, save: (doc: NonNullable<typeof page>["content"], actor: string) => store.saveDay({ day, content: doc, plainText: docText(doc), actor }) };
}

const BLOCK_OPS: Record<string, BlockOp["op"]> = { replace_block: "replace", insert_after: "insert_after", delete_block: "delete" };

export interface ToolRun {
  message: LocalMessage;
  log: string[];
  /** The section after the edits (new blocks join it). */
  section?: Section | null;
}

/** Runs the calls and gives back the message that carries their results to the model. */
export async function runTools(store: JournalStore, calls: ToolCall[], actor: string, section?: Section | null, now = new Date()): Promise<ToolRun> {
  const log: string[] = [];
  const parts: string[] = [];
  for (const c of calls) {
    const a = c.arguments;
    const target: Target = section ? { day: section.day, title: section.title } : { day: typeof a.date === "string" ? a.date : undefined, title: typeof a.title === "string" ? a.title : undefined };
    let out: string;
    let bad = false;
    try {
      if (c.error) [out, bad] = [c.error, true];
      else if (c.name === "read_blocks") {
        const n = await note(store, target, now);
        out = n ? `# ${n.name}${section ? ` (section: ${section.label})` : ""}\n${numbered(n.doc, section)}` : "No such page.";
        bad = !n;
      } else if (BLOCK_OPS[c.name]) {
        const n = await note(store, target, now);
        if (!n) [out, bad] = ["No such page.", true];
        else {
          await window.__journalFlush?.();
          const op = { op: BLOCK_OPS[c.name], n: Number(a.n), text: String(a.text ?? "") } as BlockOp;
          const r = applyBlockOp(n.doc, op, section);
          if (typeof r === "string") [out, bad] = [r, true];
          else {
            await n.save(r.doc, actor);
            section = r.section;
            window.dispatchEvent(new Event("journal:reload-page"));
            out = `Done. Now:\n${numbered(r.doc, section)}`;
          }
        }
      } else if (section && !READ_TOOLS.some((t) => t.name === c.name)) {
        [out, bad] = [`Only the picked section can be changed: use read_blocks, replace_block, insert_after or delete_block.`, true];
      } else {
        const r = await runMcpTool(store, { tool: c.name, args: a, actor }, now);
        [out, bad] = [r.content.map((p) => p.text).join("\n"), !!r.isError];
      }
    } catch (e) {
      [out, bad] = [e instanceof Error ? e.message : String(e), true];
    }
    parts.push(`<tool_response>\n${out.slice(0, 6000)}\n</tool_response>`);
    log.push(`${bad ? "⚠" : "✓"} ${c.name}${a.n !== undefined ? ` ${a.n}` : ""}${a.date ? ` ${a.date}` : ""}${a.title ? ` “${a.title}”` : ""}`);
  }
  return { message: { role: "user", content: parts.join("\n") }, log, section };
}
