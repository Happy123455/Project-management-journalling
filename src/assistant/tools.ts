// Item 13: the assistant's own tools, on top of the journal's shared ones (ai/journalTools.ts,
// src/mcp.ts and the block tools in ai/agent.ts). Every write goes through the store under the
// assistant's name, so it shows in Settings → AI changes with Undo. Before a delete, or a write
// to a second note in one run, the person is asked (a scheduled run can't ask, so it skips it).
import type { JSONContent } from "@tiptap/core";
import type { JournalStore } from "../store";
import { runOneTool, toolsFor, type ToolCall } from "../ai/agent";
import { AI_OPEN_EVENT } from "../ai/journalTools";
import { appendBlocks } from "../lib/append";
import { readAloud } from "../lib/readAloud";
import { showToast } from "../lib/toast";
import { fx } from "../lib/fx";
import { haptic } from "../lib/haptic";
import { addDays, dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { emptySheet, setCells } from "../lib/sheet";
import { deadlineRows } from "../editor/deadlineStore";
import { loadConfig, writeLog } from "../routine/routineData";
import { insertUnder, linesToBlocks, nodeAt, taskBlock, tasksIn, tickTask, topCounts, type FoundTask } from "./noteOps";

export interface RunCtx {
  store: JournalStore;
  actor: string;
  now: Date;
  /** Asks the person (true: go ahead). A scheduled run has none: such steps are skipped. */
  confirm?: (question: string) => Promise<boolean>;
  /** Notes changed so far in this run. */
  touched: Set<string>;
  /** Tasks found by find_tasks, by their number. */
  found: FoundTask[];
  /** Notes opened (to tell the person). */
  opened: string[];
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const DATE = { type: "string", description: "YYYY-MM-DD (today if left out)" };
const TITLE = { type: "string", description: "a page title instead of a date" };

export const ASSISTANT_TOOLS = [
  { name: "open", description: "Show a note on screen: a day (YYYY-MM-DD, today, yesterday) or a page title. new_tab opens it in a new tab (several opens with new_tab make several tabs).", parameters: obj({ target: { type: "string" }, new_tab: { type: "boolean" } }, ["target"]) },
  { name: "find_tasks", description: "Find checkbox tasks in day notes, newest day first (last 120 days unless from/to). Each gets a number for copy_task.", parameters: obj({ open: { type: "boolean", description: "only unticked ones (default true)" }, query: { type: "string", description: "words the task must have" }, from: DATE, to: DATE, limit: { type: "integer" } }) },
  { name: "copy_task", description: "Copy a task found by find_tasks (by its number) into a note, under a heading or box line (e.g. 'Journal'); the heading is made if missing.", parameters: obj({ n: { type: "integer" }, under: { type: "string" }, date: DATE, title: TITLE }, ["n"]) },
  { name: "put_under", description: "Add text under a heading or box line of a note (the end of that section); the heading is made if missing. '- [ ] x' lines become tasks.", parameters: obj({ text: { type: "string" }, under: { type: "string" }, date: DATE, title: TITLE }, ["text", "under"]) },
  { name: "tick_task", description: "Tick (or untick with undo=true) the first task whose text has these words, in a note (today if no date).", parameters: obj({ text: { type: "string" }, date: DATE, title: TITLE, undo: { type: "boolean" } }, ["text"]) },
  { name: "day_list", description: "Days whose note mentions the words, oldest first (or newest first), numbered. Use it for 'the 3rd day of college', 'the first day I wrote about X'.", parameters: obj({ query: { type: "string" }, newest_first: { type: "boolean" }, limit: { type: "integer" } }, ["query"]) },
  { name: "usage_counts", description: "Counts for a table: the most used tags, links ([[pages]]), files, or memes/GIFs in day notes between from and to (default the last 90 days).", parameters: obj({ what: { type: "string", enum: ["tags", "links", "files", "memes"] }, from: DATE, to: DATE, limit: { type: "integer" } }, ["what"]) },
  { name: "add_table", description: "Add a table (spreadsheet block) at the end of a note: a header row and rows of cells.", parameters: obj({ headers: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { type: "string" } } }, date: DATE, title: TITLE }, ["headers", "rows"]) },
  { name: "add_reminder", description: "A reminder: a '⏰ HH:MM text' line on that day's note, which rings at that time (on the phone).", parameters: obj({ text: { type: "string" }, date: DATE, time: { type: "string", description: "HH:MM, 24-hour" } }, ["text", "time"]) },
  { name: "add_deadline", description: "A ⏳ deadline bar in today's note running to the due day (and time).", parameters: obj({ title: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM (default 23:59)" } }, ["title", "due"]) },
  { name: "start_timer", description: "A countdown timer that rings when done (while the app is open).", parameters: obj({ minutes: { type: "number" }, label: { type: "string" } }, ["minutes"]) },
  { name: "log_routine", description: "Log a routine step or habit now (e.g. 'Gym' start, 'Brush' point) in today's Routine box.", parameters: obj({ item: { type: "string" }, edge: { type: "string", enum: ["start", "end", "point"] }, note: { type: "string" } }, ["item"]) },
  { name: "read_aloud", description: "Read text aloud to the person (a summary you wrote, a note's text).", parameters: obj({ text: { type: "string" } }, ["text"]) },
];

/** Every tool the assistant offers: the shared ones (without open_note) and its own. */
export const assistantToolList = () => [...toolsFor(null).filter((t) => t.name !== "open_note"), ...ASSISTANT_TOOLS];

const WRITES = new Set(["append", "replace_text", "add_to_page", "set_cells", "add_sheet", "add_rule", "save_graph", "replace_block", "insert_after", "delete_block", "copy_task", "put_under", "tick_task", "add_table", "add_reminder", "add_deadline", "log_routine"]);

/** Which note a write lands on, for the "second note" check. */
function noteOf(name: string, a: Record<string, unknown>, now: Date): string {
  if (name === "add_to_page" || name === "add_rule") return `page:${String(name === "add_rule" ? "AI rules" : a.title ?? "").toLowerCase()}`;
  if (typeof a.title === "string" && a.title.trim()) return `page:${a.title.trim().toLowerCase()}`;
  if (name === "add_deadline" || name === "log_routine") return `day:${dayKey(now)}`;
  return `day:${typeof a.date === "string" && a.date ? a.date : dayKey(now)}`;
}

const isDelete = (name: string, a: Record<string, unknown>) => name === "delete_block" || (name === "replace_text" && !String(a.replace ?? "").trim());

interface Note {
  name: string;
  doc: JSONContent | null;
  save: (doc: JSONContent) => Promise<unknown>;
}
async function noteFor(ctx: RunCtx, a: Record<string, unknown>): Promise<Note | string> {
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (title) {
    const page = await ctx.store.getPage(title);
    if (!page) return `No page called "${title}".`;
    return { name: page.title, doc: page.content, save: (doc) => ctx.store.savePage({ id: page.id, content: doc, plainText: docText(doc), actor: ctx.actor }) };
  }
  const day = typeof a.date === "string" && a.date ? (a.date === "today" ? dayKey(ctx.now) : a.date) : dayKey(ctx.now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "date must be YYYY-MM-DD";
  const page = await ctx.store.getDay(day);
  return { name: day, doc: page?.content ?? null, save: (doc) => ctx.store.saveDay({ day, content: doc, plainText: docText(doc), actor: ctx.actor }) };
}

/** Saves a note the assistant changed and shows it as it is now. */
async function saved(note: Note, doc: JSONContent, said: string) {
  await window.__journalFlush?.();
  await note.save(doc);
  window.dispatchEvent(new Event("journal:reload-page"));
  return said;
}

type Out = { out: string; bad: boolean };
const ok = (out: string): Out => ({ out, bad: false });
const bad = (out: string): Out => ({ out, bad: true });

let timers = 0;

/** One tool call from the assistant. */
export async function runAssistantTool(call: ToolCall, ctx: RunCtx): Promise<Out> {
  const a = call.arguments ?? {};
  const { store, now } = ctx;
  if (WRITES.has(call.name)) {
    const note = noteOf(call.name, a, now);
    const second = ctx.touched.size > 0 && !ctx.touched.has(note);
    if (isDelete(call.name, a) || second) {
      const q = isDelete(call.name, a) ? `Delete from ${note.slice(note.indexOf(":") + 1)}?` : `Also change ${note.slice(note.indexOf(":") + 1)}?`;
      if (!ctx.confirm) return bad(`Not done: "${q}" needs the person's OK, and this run can't ask. Tell them.`);
      if (!(await ctx.confirm(q))) return bad("The person said no. Don't do it; carry on with the rest if it makes sense.");
    }
    ctx.touched.add(note);
  }
  try {
    switch (call.name) {
      case "open": {
        let target = String(a.target ?? "").trim();
        if (!target) return bad("target is empty");
        if (/^(today|yesterday|tomorrow)$/i.test(target)) target = addDays(dayKey(now), { today: 0, yesterday: -1, tomorrow: 1 }[target.toLowerCase() as "today"]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
          const page = await store.getPage(target);
          if (!page) {
            const names = (await store.pageNames()).filter((n) => n.toLowerCase().includes(target.toLowerCase())).slice(0, 8);
            return bad(`No page called "${target}".${names.length ? ` Did you mean: ${names.join(", ")}?` : ""}`);
          }
          target = page.title;
        }
        window.dispatchEvent(new CustomEvent(AI_OPEN_EVENT, { detail: { target, newTab: !!a.new_tab, now: true } }));
        ctx.opened.push(target);
        // Tabs open one after another, not all at once.
        await new Promise((r) => setTimeout(r, 350));
        return ok(`Opened ${target}${a.new_tab ? " in a new tab" : ""}.`);
      }
      case "find_tasks": {
        const open = a.open !== false;
        const want = String(a.query ?? "").toLowerCase();
        const limit = Math.min(50, Number(a.limit) || 20);
        const to = typeof a.to === "string" && a.to ? a.to : dayKey(now);
        const from = typeof a.from === "string" && a.from ? a.from : addDays(to, -120);
        const days = (await store.listDays()).filter((d) => d >= from && d <= to).sort().reverse();
        const out: FoundTask[] = [];
        for (const day of days) {
          if (out.length >= limit) break;
          const page = await store.getDay(day);
          for (const t of tasksIn(day, page?.content)) if ((!open || !t.checked) && t.text && (!want || t.text.toLowerCase().includes(want)) && out.length < limit) out.push(t);
        }
        ctx.found = out;
        if (!out.length) return ok(`No ${open ? "unticked " : ""}tasks${want ? ` with "${want}"` : ""} from ${from} to ${to}.`);
        return ok(out.map((t, i) => `${i + 1}. [${t.note}] ${t.checked ? "☑" : "☐"} ${t.text}`).join("\n"));
      }
      case "copy_task": {
        const t = ctx.found[Number(a.n) - 1];
        if (!t) return bad("No such task number: call find_tasks first.");
        const src = await store.getDay(t.note);
        const item = src && nodeAt(src.content, t.path);
        if (!item) return bad("That task has moved; call find_tasks again.");
        const note = await noteFor(ctx, a);
        if (typeof note === "string") return bad(note);
        const under = String(a.under ?? "").trim();
        const block = taskBlock(item);
        const r = under ? insertUnder(note.doc, under, [block]) : { doc: appendBlocks(note.doc, [block]), found: true };
        return ok(await saved(note, r.doc, `Copied "${t.text}" into ${note.name}${under ? ` under ${under}${r.found ? "" : " (new heading)"}` : ""}.`));
      }
      case "put_under": {
        const note = await noteFor(ctx, a);
        if (typeof note === "string") return bad(note);
        const under = String(a.under ?? "").trim();
        const r = insertUnder(note.doc, under, linesToBlocks(String(a.text ?? "")));
        return ok(await saved(note, r.doc, `Added under ${under} in ${note.name}${r.found ? "" : " (new heading)"}.`));
      }
      case "tick_task": {
        const note = await noteFor(ctx, a);
        if (typeof note === "string") return bad(note);
        if (!note.doc) return bad(`${note.name} is empty.`);
        const r = tickTask(note.doc, String(a.text ?? ""), !a.undo);
        if (!r) return bad(`No ${a.undo ? "ticked" : "open"} task with "${a.text}" in ${note.name}.`);
        return ok(await saved(note, r.doc, `${a.undo ? "Unticked" : "Ticked"} "${r.task}" in ${note.name}.`));
      }
      case "day_list": {
        const q = String(a.query ?? "").trim();
        if (!q) return bad("query is empty");
        const hits = (await store.search(q)).filter((h) => h.kind === "day" && h.day) as { day: string; text: string }[];
        const days = [...new Set(hits.map((h) => h.day))].sort();
        if (a.newest_first) days.reverse();
        const limit = Math.min(60, Number(a.limit) || 20);
        if (!days.length) return ok(`No day mentions "${q}".`);
        return ok(`${days.length} day${days.length === 1 ? "" : "s"} mention "${q}" (${a.newest_first ? "newest" : "oldest"} first):\n${days.slice(0, limit).map((d, i) => `${i + 1}. ${d}`).join("\n")}`);
      }
      case "usage_counts": {
        const what = String(a.what ?? "tags");
        const to = typeof a.to === "string" && a.to ? a.to : dayKey(now);
        const from = typeof a.from === "string" && a.from ? a.from : addDays(to, -90);
        const limit = Math.min(30, Number(a.limit) || 10);
        let items: string[] = [];
        if (what === "tags" || what === "links") {
          const kind = what === "tags" ? "tag" : "wikilink";
          items = (await store.graphLinks()).filter((l) => l.kind === kind && (!l.day || (l.day >= from && l.day <= to))).map((l) => (kind === "tag" ? `#${l.target}` : `[[${l.target}]]`));
        } else {
          const days = (await store.listDays()).filter((d) => d >= from && d <= to);
          for (const day of days) {
            const page = await store.getDay(day);
            const walk = (n: JSONContent) => {
              const name = String(n.attrs?.name ?? "");
              if (n.attrs?.fileId && /^attachment/.test(n.type ?? "")) {
                const meme = /^(meme-|gif-)/i.test(name) || /\.gif$/i.test(name) || /gif$/i.test(String(n.attrs?.mime ?? ""));
                if (what === "files" || meme) items.push(name || String(n.attrs.fileId));
              }
              n.content?.forEach(walk);
            };
            if (page?.content) walk(page.content);
          }
        }
        const rows = topCounts(items, limit);
        if (!rows.length) return ok(`No ${what} between ${from} and ${to}.`);
        return ok(`Top ${what}, ${from} to ${to}:\n${rows.map(([k, n], i) => `${i + 1}. ${k}: ${n}`).join("\n")}`);
      }
      case "add_table": {
        const headers = Array.isArray(a.headers) ? a.headers.map(String) : [];
        const rows = Array.isArray(a.rows) ? (a.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [String(r)])) : [];
        if (!headers.length) return bad("headers are empty");
        const note = await noteFor(ctx, a);
        if (typeof note === "string") return bad(note);
        const cols = Math.max(headers.length, ...rows.map((r) => r.length));
        const col = (i: number) => String.fromCharCode(65 + i);
        const patch: Record<string, string> = {};
        [headers, ...rows].forEach((r, y) => r.forEach((v, x) => x < 26 && (patch[`${col(x)}${y + 1}`] = v)));
        const data = setCells(emptySheet(Math.min(200, rows.length + 1), Math.min(26, cols)), patch);
        if (typeof data === "string") return bad(data);
        const block = { type: "sheetBlock", attrs: { data: JSON.stringify(data) } };
        return ok(await saved(note, appendBlocks(note.doc, [block, { type: "paragraph" }]), `Added a ${rows.length + 1}×${cols} table to ${note.name}.`));
      }
      case "add_reminder": {
        const time = String(a.time ?? "").match(/^(\d{1,2}):(\d{2})$/);
        if (!time) return bad("time must be HH:MM");
        const note = await noteFor(ctx, { date: a.date });
        if (typeof note === "string") return bad(note);
        const line = `⏰ ${time[1].padStart(2, "0")}:${time[2]} ${String(a.text ?? "").trim()}`;
        return ok(await saved(note, appendBlocks(note.doc, linesToBlocks(line)), `Reminder on ${note.name}: ${line}`));
      }
      case "add_deadline": {
        const due = String(a.due ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return bad("due must be YYYY-MM-DD");
        const [h, m] = String(a.time ?? "23:59").split(":").map(Number);
        const end = new Date(`${due}T00:00:00`);
        end.setHours(h || 0, m || 0);
        if (end.getTime() <= now.getTime()) return bad("The due time has passed.");
        const note = await noteFor(ctx, {});
        if (typeof note === "string") return bad(note);
        const title = String(a.title ?? "Deadline").trim();
        return ok(await saved(note, appendBlocks(note.doc, deadlineRows(end.getTime(), title, {}, dayKey(now)) as JSONContent[]), `⏳ "${title}" due ${due} ${String(a.time ?? "23:59")}, in today's note.`));
      }
      case "start_timer": {
        const min = Number(a.minutes);
        if (!(min > 0) || min > 24 * 60) return bad("minutes must be between 0 and 1440");
        const label = String(a.label ?? "Timer").trim() || "Timer";
        const id = ++timers;
        window.setTimeout(() => {
          fx("done");
          haptic("edge", 1);
          showToast(`⏱ ${label}: ${min} min done`, "info");
          readAloud(`${label} is done.`);
        }, min * 60_000);
        showToast(`⏱ ${label}: ${min} min`, "info");
        return ok(`Timer ${id} set for ${min} minutes (${label}).`);
      }
      case "log_routine": {
        const want = String(a.item ?? "").toLowerCase().trim();
        const config = await loadConfig(store);
        const all = [...config.steps, ...config.habits];
        const item = all.find((x) => x.label.toLowerCase() === want) ?? all.find((x) => x.label.toLowerCase().includes(want) || want.includes(x.label.toLowerCase()));
        if (!item) return bad(`No routine step or habit like "${a.item}". There are: ${all.map((x) => x.label).join(", ")}.`);
        const edge = a.edge === "start" || a.edge === "end" ? a.edge : "point";
        await writeLog(store, item, edge, now, { note: typeof a.note === "string" ? a.note : undefined, actor: ctx.actor });
        return ok(`Logged ${item.icon} ${item.label}${edge === "point" ? "" : ` ${edge}`}.`);
      }
      case "read_aloud": {
        const text = String(a.text ?? "").trim();
        if (!text) return bad("text is empty");
        readAloud(text);
        return ok("Reading it aloud now.");
      }
      default: {
        const r = await runOneTool(store, call, ctx.actor, null, now);
        return { out: r.out, bad: r.bad };
      }
    }
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
}
