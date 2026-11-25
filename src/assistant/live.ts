// Live agents (Hapi, 21 Nov: "like Gemini Live"). Tap a bubble and it listens until tapped again:
// every sentence is one quick request ("a comparison table of cows and dogs"), made into a block
// at once, and a correction ("sorry, not cow, dinosaur") rebuilds that block in place with the
// delete-and-build show. No chat panel. Fast models only: on the Mac the quickest local model
// (Ollama), on the phone Gemini's quickest. Anything that isn't a block (a reminder, opening a
// note, a question about the journal) goes to the normal assistant with its tools.
import type { JSONContent } from "@tiptap/core";
import type { JournalStore } from "../store";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { emptySheet, setCells } from "../lib/sheet";
import { appendBlocks } from "../lib/append";
import { localAvailable, localModels } from "../ai/client";
import { getKey } from "../ai/secrets";
import { OLLAMA_URL } from "../ai/providers";
import { canSetThinking, geminiCall, type GeminiJson } from "../ai/gemini";
import { recordUsage } from "../ai/settings";
import { watchEdit } from "./swarm/watch";
import { runAssistant } from "./runner";

export type LiveKind = "table" | "list" | "checklist" | "text" | "numbered" | "heading" | "code" | "quote";

/** The block this live agent made last (what "not cow, dinosaur" changes). */
export interface LiveBlock {
  /** The day note it's in (or, with `title`, the page's name). */
  day: string;
  title?: string;
  kind: LiveKind;
  /** The node's fingerprint (blockPrint), to find it again after the editor adds its ids. */
  json: string;
  /** Its content as the model sees it. */
  shown: string;
  headers?: string[];
  rows?: string[][];
  lines?: string[];
}

export interface LivePlan {
  action: "make" | "edit" | "delete" | "other" | "none";
  kind?: LiveKind;
  headers?: string[];
  rows?: unknown;
  lines?: string[];
  /** code: its language. */
  language?: string;
  say?: string;
}

export interface LiveCtx {
  store: JournalStore;
  actor: string;
  last: LiveBlock | null;
  /** The last few things said, so "make it shorter" has something to refer to. */
  said: string[];
}

/** Fastest first (21 Nov on Hapi's Mac: llama3.2 ~48 tok/s, qwen3:8b ~23, qwen3:14b ~13). */
export const LOCAL_FAST = ["qwen3:4b", "qwen3:1.7b", "gemma3:4b", "llama3.2:3b", "llama3.2", "qwen2.5:3b", "phi4-mini", "qwen3:8b", "gemma3:12b", "qwen3:14b"];
/** Gemini's quickest first; the chain moves on when one is busy or gone. */
export const GEMINI_FAST = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-3.8-flash"];

const onMac = () => "__TAURI_INTERNALS__" in window && !window.JournalSecrets;

let localPick: { model: string; at: number } | null = null;

/** The quickest local model that's installed (checked once a minute), or null. */
export async function fastLocalModel(): Promise<string | null> {
  if (!onMac()) return null;
  try {
    const forced = localStorage.getItem("journal.liveModel");
    if (forced) return forced;
  } catch {
    // No storage.
  }
  if (localPick && Date.now() - localPick.at < 60_000) return localPick.model || null;
  let model = "";
  if (await localAvailable()) {
    const have = (await localModels()).map((m) => m.toLowerCase());
    model = LOCAL_FAST.find((m) => have.includes(m) || have.includes(`${m}:latest`)) ?? "";
    if (!model) model = have.find((m) => !/embed|whisper|vision|llava/.test(m)) ?? "";
  }
  localPick = { model, at: Date.now() };
  return model || null;
}

export function livePrompt(last: LiveBlock | null, said: string[]): string {
  return (
    "You are a live voice helper inside a journal app. The person says one sentence; turn it into one block, fast. " +
    "Reply only with JSON. action: " +
    '"make" = a new block (a table, list or text they ask for); ' +
    '"edit" = they correct or change the last block ("not cow, dinosaur", "add a row for speed", "make it shorter", "sorry, I meant…"): give the WHOLE new block with the change, keep everything else the same; ' +
    '"delete" = remove the last block; ' +
    '"other" = anything else for the journal (reminders, deadlines, money, opening a note or day, finding something, tasks); ' +
    '"none" = not a request (noise, thanks, half a word). ' +
    "kind: table (headers + rows of short cells, 4 to 7 rows unless they say), list (lines), text (lines). " +
    "say: 3 to 8 words about what you did. Write in the person's language, plain facts, no markdown in cells.\n" +
    (last ? `The last block (kind ${last.kind}):\n${last.shown}\n` : "There is no last block yet.\n") +
    (said.length ? `Said before: ${said.slice(-3).map((s) => `"${s}"`).join(", ")}\n` : "")
  );
}

const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["make", "edit", "delete", "other", "none"] },
    kind: { type: "string", enum: ["table", "list", "text"] },
    headers: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    lines: { type: "array", items: { type: "string" } },
    say: { type: "string" },
  },
  required: ["action"],
};

/** Reads the model's JSON, forgiving code fences and a stray word before it. */
export function parsePlan(raw: string): LivePlan | null {
  const s = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1)) as LivePlan;
    if (!j || !["make", "edit", "delete", "other", "none"].includes(j.action)) return null;
    const cell = (v: unknown) => String(v ?? "").replace(/\*\*/g, "").trim();
    if (Array.isArray(j.headers)) j.headers = j.headers.map(cell);
    if (Array.isArray(j.headers) && j.rows != null) j.rows = normalizeRows(j.headers, j.rows);
    if (Array.isArray(j.lines)) j.lines = j.lines.map(cell).filter(Boolean);
    if (!j.kind) j.kind = j.headers?.length ? "table" : j.lines?.length ? "list" : undefined;
    return j;
  } catch {
    return null;
  }
}

/** One quick question to the fastest model this device has. Returns the plan and who answered. */
export async function askFast(text: string, ctx: LiveCtx, signal?: AbortSignal): Promise<{ plan: LivePlan | null; model: string }> {
  const system = livePrompt(ctx.last, ctx.said);
  const local = await fastLocalModel();
  if (local) {
    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(60_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: local,
          stream: false,
          think: false,
          format: SCHEMA,
          keep_alive: "30m",
          options: { num_ctx: 4096, temperature: 0.2 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: text },
          ],
        }),
      });
      if (res.ok) {
        const body = await res.json();
        recordUsage(local, body.prompt_eval_count ?? 0, body.eval_count ?? 0);
        return { plan: parsePlan(body.message?.content ?? ""), model: local };
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      // Ollama stopped: Gemini takes over below.
    }
  }
  const key = await getKey("gemini");
  if (!key) throw new Error(local ? "The local model didn't answer and there's no Gemini key." : "Add a Gemini key in Settings → AI (or start Ollama on the Mac).");
  const r = await geminiCall({
    key,
    model: GEMINI_FAST[0],
    chain: GEMINI_FAST,
    fastTimeoutMs: 12_000,
    signal,
    quiet: true,
    body: (m) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        // Live means quick: as little thinking as the model allows.
        ...(canSetThinking(m) ? { thinkingConfig: { thinkingLevel: m.includes("lite") ? "minimal" : "low" } } : {}),
      },
    }),
  });
  const json = r.json as GeminiJson & { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  recordUsage(r.model, json.usageMetadata?.promptTokenCount ?? 0, json.usageMetadata?.candidatesTokenCount ?? 0);
  const out = (json.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  return { plan: parsePlan(out), model: r.model };
}

/** Cuts at commas that aren't inside brackets or quotes. */
function commaCut(t: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      if (ch === quote && t[i - 1] !== "\\") quote = "";
      cur += ch;
      continue;
    }
    // A quote opens only at the start of a cell (an apostrophe in "Today's" doesn't).
    if ((ch === '"' || ch === "'") && !cur.trim()) quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(unquote);
}

const unquote = (c: string) => c.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();

/** A row written as an array in text: '["Diet","Grass"]', "['Diet', 'Grass']" or "[Diet, Grass]". */
function arrayText(s: string): string[] | null {
  const t = s.trim();
  if (!/^\[[\s\S]*\]$/.test(t)) return null;
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.map((x) => String(x ?? "").trim());
  } catch {
    // Not JSON: single quotes or none.
  }
  const cells = commaCut(t.slice(1, -1));
  return cells.length ? cells : null;
}

/** Splits a row written as one line ("Dogs, loyal, 4 legs" or "| Dogs | loyal |") into cells. */
function splitLine(line: string, want: number): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const arr = arrayText(t);
  if (arr) return arr;
  const by = (sep: RegExp) => t.split(sep).map((c) => c.trim());
  if (t.includes("|")) return by(/\s*\|\s*/);
  if (t.includes("\t")) return by(/\t/);
  let cells = commaCut(t);
  // Too many: first put numbers like "10,000" back together…
  for (let i = 0; want > 1 && cells.length > want && i < cells.length - 1; ) {
    if (/\d$/.test(cells[i]) && /^\d{3}(?!\d)/.test(cells[i + 1])) cells = [...cells.slice(0, i), `${cells[i]},${cells[i + 1]}`, ...cells.slice(i + 2)];
    else i++;
  }
  // …then commas inside the last cell ("loyal, playful") stay in it.
  if (want > 1 && cells.length > want) cells = [...cells.slice(0, want - 1), cells.slice(want - 1).join(", ")];
  return cells;
}

/**
 * Rows as cells, one per header. 25 Nov: a model sent each row as one comma line ("Dogs,Living
 * species,Loyalty") and the whole row landed in one cell; rows also come as text arrays
 * ("['Diet', 'Grass']"), as a flat list of strings, or as {header: value} objects.
 */
export function normalizeRows(headers: string[], rows: unknown): string[][] {
  const want = Math.max(1, headers.length);
  let list: unknown[] = Array.isArray(rows) ? rows : typeof rows === "string" ? (arrayText(rows) && /^\s*\[\s*\[/.test(rows) ? (JSON.parse(rows) as unknown[]) : rows.split(/\n+/)) : [];
  if (!Array.isArray(list)) list = [];
  const cell = (v: unknown) => String(v ?? "").replace(/\*\*/g, "").trim();
  const out: string[][] = [];
  for (const r of list) {
    let cells: string[];
    if (Array.isArray(r)) cells = r.map(cell);
    else if (r && typeof r === "object") cells = headers.length ? headers.map((h) => cell((r as Record<string, unknown>)[h])) : Object.values(r).map(cell);
    else cells = [cell(r)];
    // A whole row as an array in text.
    if (cells.length === 1 && arrayText(cells[0])) cells = arrayText(cells[0])!;
    // One long cell where several were wanted: it's a whole row in one line.
    if (want > 1 && cells.filter(Boolean).length === 1 && /[,|\t]/.test(cells.find(Boolean) ?? "")) cells = splitLine(cells.find(Boolean)!, want);
    // Several rows run together in one array ("Dogs,…", "Cats,…" each a row in one row).
    else if (want > 1 && cells.length > 1 && cells.length < want && cells.every((c) => splitLine(c, want).length === want)) {
      for (const c of cells) out.push(splitLine(c, want));
      continue;
    }
    if (cells.some(Boolean)) out.push(cells.map(unquote));
  }
  return out;
}

/** The block for a plan, and how the model will see it next time. */
export function blockFor(plan: LivePlan): { node: JSONContent; kind: LiveKind; shown: string; headers?: string[]; rows?: string[][]; lines?: string[] } | null {
  if (plan.kind === "table" || (plan.headers?.length && Array.isArray(plan.rows) && plan.rows.length)) {
    let headers = (plan.headers ?? []).map((h) => String(h ?? "").trim()).slice(0, 26);
    // Headers as one comma line too.
    if (headers.length === 1 && /[,|]/.test(headers[0])) headers = splitLine(headers[0], 0).slice(0, 26);
    const rows = normalizeRows(headers, plan.rows).slice(0, 199);
    if (!headers.length) return null;
    const cols = Math.min(26, Math.max(headers.length, ...rows.map((r) => r.length)));
    const col = (i: number) => String.fromCharCode(65 + i);
    const patch: Record<string, string> = {};
    [headers, ...rows].forEach((r, y) => r.forEach((v, x) => x < 26 && (patch[`${col(x)}${y + 1}`] = v)));
    const data = setCells(emptySheet(rows.length + 1, cols), patch);
    if (typeof data === "string") return null;
    const shown = [headers, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
    return { node: { type: "sheetBlock", attrs: { data: JSON.stringify(data) } }, kind: "table", shown, headers, rows };
  }
  const lines = (Array.isArray(plan.lines) ? plan.lines : typeof plan.lines === "string" ? String(plan.lines).split(/\n+/) : []).map((l) => String(l ?? "").replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, "").trim()).filter(Boolean);
  if (!lines.length) return null;
  if (plan.kind === "checklist") {
    return {
      node: { type: "taskList", content: lines.map((l) => ({ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: l }] }] })) },
      kind: "checklist",
      shown: lines.map((l) => `- [ ] ${l}`).join("\n"),
      lines,
    };
  }
  if (plan.kind === "text") return { node: { type: "paragraph", content: [{ type: "text", text: lines.join(" ") }] }, kind: "text", shown: lines.join(" "), lines: [lines.join(" ")] };
  // 25 Nov, Hapi: "it can create any block".
  if (plan.kind === "numbered")
    return { node: { type: "orderedList", content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: l }] }] })) }, kind: "numbered", shown: lines.map((l, i) => `${i + 1}. ${l}`).join("\n"), lines };
  if (plan.kind === "heading") return { node: { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: lines.join(" ") }] }, kind: "heading", shown: `## ${lines.join(" ")}`, lines: [lines.join(" ")] };
  if (plan.kind === "quote") return { node: { type: "blockquote", content: lines.map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] })) }, kind: "quote", shown: lines.map((l) => `> ${l}`).join("\n"), lines };
  if (plan.kind === "code") {
    // Code keeps its indentation (lines were trimmed above for lists).
    const raw = (Array.isArray(plan.lines) ? plan.lines : String(plan.lines ?? "").split("\n")).map((l) => String(l ?? "")).join("\n").replace(/^\n+|\s+$/g, "");
    return { node: { type: "codeBlock", attrs: { language: plan.language ?? null }, content: raw ? [{ type: "text", text: raw }] : [] }, kind: "code", shown: "```\n" + raw + "\n```", lines: raw.split("\n") };
  }
  if (plan.kind === "list" || lines.length > 1) {
    return {
      node: { type: "bulletList", content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: l }] }] })) },
      kind: "list",
      shown: lines.map((l) => `- ${l}`).join("\n"),
      lines,
    };
  }
  return { node: { type: "paragraph", content: [{ type: "text", text: lines[0] }] }, kind: "text", shown: lines[0], lines };
}

/** Where the live block goes: the day on screen (today when a page is open). */
export const liveDay = () => window.__journalOpenDay?.() || dayKey(new Date());

/** What a block is, ignoring the attributes the editor adds (line ids): a table's data or the text. */
export function blockPrint(n: JSONContent | null | undefined): string {
  if (!n) return "";
  const data = (n.attrs as { data?: unknown } | undefined)?.data;
  return `${n.type}|${typeof data === "string" ? data : docText({ type: "doc", content: [n] })}`;
}

/** Puts `node` in place of `old` (or at the end), or removes `old` when node is null. */
export function placeBlock(doc: JSONContent | null, node: JSONContent | null, old: string | null): { doc: JSONContent; replaced: boolean } {
  const content = [...(doc?.content ?? [])];
  const at = old ? content.findIndex((n) => blockPrint(n) === old) : -1;
  if (at >= 0) {
    if (node) content.splice(at, 1, node);
    else {
      content.splice(at, 1);
      // Its blank line after goes too.
      const next = content[at];
      if (next?.type === "paragraph" && !next.content?.length) content.splice(at, 1);
    }
    if (!content.length) content.push({ type: "paragraph" });
    return { doc: { ...(doc ?? { type: "doc" }), type: "doc", content }, replaced: true };
  }
  if (!node) return { doc: doc ?? { type: "doc", content: [{ type: "paragraph" }] }, replaced: false };
  return { doc: appendBlocks(doc, [node, { type: "paragraph" }]), replaced: false };
}

async function write(ctx: LiveCtx, day: string, doc: JSONContent, tool: string, text: string) {
  const done = watchEdit({ tool, text, actor: ctx.actor, fast: true });
  await window.__journalFlush?.();
  await ctx.store.saveDay({ day, content: doc, plainText: docText(doc), actor: ctx.actor });
  window.dispatchEvent(new Event("journal:reload-page"));
  done();
}

export interface LiveResult {
  /** What to show by the bubble. */
  say: string;
  model: string;
  ok: boolean;
}

/** One sentence heard while live. */
export async function liveTurn(text: string, ctx: LiveCtx, signal?: AbortSignal, confirm?: (q: string) => Promise<boolean>): Promise<LiveResult> {
  const said = text.trim();
  if (!said) return { say: "", model: "", ok: true };
  const { plan, model } = await askFast(said, ctx, signal);
  ctx.said = [...ctx.said, said].slice(-6);
  if (!plan) return { say: "Didn't get that, say it again?", model, ok: false };
  if (plan.action === "none") return { say: "", model, ok: true };
  if (plan.action === "other") {
    const r = await runAssistant({ store: ctx.store, text: said, actor: ctx.actor, signal, confirm });
    return { say: r.answer.split("\n")[0].slice(0, 160), model: r.fast ? "" : "Gemini", ok: true };
  }
  const last = ctx.last;
  if (plan.action === "delete") {
    if (!last) return { say: "Nothing of mine to delete yet.", model, ok: false };
    const page = await ctx.store.getDay(last.day);
    const { doc, replaced } = placeBlock(page?.content ?? null, null, last.json);
    if (!replaced) return { say: "That block was changed by hand; left it.", model, ok: false };
    await write(ctx, last.day, doc, "delete_block", "");
    ctx.last = null;
    return { say: plan.say || "Deleted it.", model, ok: true };
  }
  const b = blockFor(plan);
  if (!b) return { say: plan.say || "Couldn't make a block from that.", model, ok: false };
  const edit = plan.action === "edit" && !!last;
  const day = edit ? last!.day : liveDay();
  const page = await ctx.store.getDay(day);
  const { doc } = placeBlock(page?.content ?? null, b.node, edit ? last!.json : null);
  await write(ctx, day, doc, b.kind === "table" ? (edit ? "set_cells" : "add_table") : edit ? "replace_block" : "append", b.shown.split("\n")[0]);
  ctx.last = { day, kind: b.kind, json: blockPrint(b.node), shown: b.shown, headers: b.headers, rows: b.rows, lines: b.lines };
  return { say: plan.say || (edit ? "Changed it." : `Made a ${b.kind}.`), model, ok: true };
}

declare global {
  interface Window {
    /** The day note on screen (App). */
    __journalOpenDay?: () => string | null;
  }
}
