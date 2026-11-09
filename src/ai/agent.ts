import { runMcpTool } from "../mcp";
import type { JournalStore } from "../store";
import { dayKey } from "../lib/timestamp";
import type { LocalMessage } from "./local";

/**
 * The journal tools the local model may call when "Can edit journal" is on in AI chat. They are the
 * MCP tools (src/mcp.ts), so every write is an event under the model's name and can be undone in
 * Settings → AI changes. Qwen's own tool format: <tool_call>{"name", "arguments"}</tool_call>.
 */
const TOOLS = [
  { name: "today", description: "Read today's note.", parameters: { type: "object", properties: {} } },
  { name: "read_day", description: "Read the note of one day.", parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"] } },
  { name: "read_page", description: "Read a named page (a project, person, topic).", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { name: "search", description: "Find days and pages containing all these words.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "list_days", description: "List every day that has a note.", parameters: { type: "object", properties: {} } },
  {
    name: "append",
    description: "Add text at the end of a day's note (today if no date). One paragraph per line; [[Page]] links and #tags work.",
    parameters: { type: "object", properties: { text: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } }, required: ["text"] },
  },
  {
    name: "replace_text",
    description: "Change text in a day's note or a named page: the first line containing `find` gets `find` replaced by `replace` (empty replace deletes it).",
    parameters: {
      type: "object",
      properties: { find: { type: "string" }, replace: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, title: { type: "string", description: "page title instead of a date" } },
      required: ["find", "replace"],
    },
  },
  {
    name: "add_to_page",
    description: "Add text at the end of a named page, creating the page if it doesn't exist.",
    parameters: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] },
  },
];

export function agentSystem(now = new Date()): string {
  return (
    `You can read and edit the user's journal with tools. Today is ${dayKey(now)}. ` +
    "Edit only what the user asks for; read the note first when you change existing text, and tell the user briefly what you changed.\n\n" +
    "# Tools\n\nYou may call one or more functions to assist with the user query.\n\n" +
    "You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n" +
    TOOLS.map((t) => JSON.stringify({ type: "function", function: t })).join("\n") +
    "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n" +
    '<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
  );
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** The tool calls in an answer, and the answer without them. */
export function parseToolCalls(answer: string): { calls: ToolCall[]; text: string } {
  const calls: ToolCall[] = [];
  const text = answer
    .replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, json: string) => {
      try {
        const c = JSON.parse(json);
        if (c && typeof c.name === "string") calls.push({ name: c.name, arguments: c.arguments ?? {} });
      } catch {
        // A malformed call is dropped; the model is told nothing ran.
      }
      return "";
    })
    .trim();
  return { calls, text };
}

/** Runs the calls and gives back the message that carries their results to the model. */
export async function runTools(store: JournalStore, calls: ToolCall[], actor: string): Promise<{ message: LocalMessage; log: string[] }> {
  const log: string[] = [];
  const parts: string[] = [];
  for (const c of calls) {
    const r = await runMcpTool(store, { tool: c.name, args: c.arguments, actor }).catch((e) => ({ content: [{ type: "text" as const, text: String(e) }], isError: true }));
    const out = r.content.map((p) => p.text).join("\n");
    parts.push(`<tool_response>\n${out.slice(0, 6000)}\n</tool_response>`);
    log.push(`${r.isError ? "⚠" : "✓"} ${c.name}${c.arguments.date ? ` ${c.arguments.date}` : ""}${c.arguments.title ? ` “${c.arguments.title}”` : ""}`);
  }
  return { message: { role: "user", content: parts.join("\n") }, log };
}
