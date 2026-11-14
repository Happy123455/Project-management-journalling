import { appendBlocks, textBlocks } from "./lib/append";
import { GRAPH_PREFIX, loadoutPageContent, parseLoadout } from "./lib/canvasLoadout";
import { dayKey } from "./lib/timestamp";
import { docText } from "./lib/words";
import type { JournalStore } from "./store";
import type { JSONContent } from "@tiptap/react";
import { runJournalTool, TOOL_SPECS } from "./ai/journalTools";
import { saveYoutubeDay } from "./lib/youtubeDigest";

/**
 * The document with the first line containing `find` changed (`find` → `replace`), or null when no
 * line has it. A match inside one piece of text keeps its formatting; one across formatting makes
 * that line plain text.
 */
export function replaceInDoc(doc: JSONContent, find: string, replace: string): JSONContent | null {
  let done = false;
  const walk = (node: JSONContent): JSONContent => {
    if (done || !node.content) return node;
    const kids = node.content;
    if (kids.length && kids.every((k) => k.type === "text" || k.type === "hardBreak")) {
      const one = kids.findIndex((k) => k.type === "text" && k.text?.includes(find));
      if (one >= 0) {
        done = true;
        return { ...node, content: kids.map((k, i) => (i === one ? { ...k, text: k.text!.replace(find, replace) } : k)).filter((k) => k.type !== "text" || k.text) };
      }
      const whole = kids.map((k) => (k.type === "text" ? k.text ?? "" : "\n")).join("");
      if (whole.includes(find)) {
        done = true;
        const next = whole.replace(find, replace);
        return { ...node, content: next ? [{ type: "text", text: next }] : [] };
      }
      return node;
    }
    return { ...node, content: kids.map(walk) };
  };
  const out = walk(doc);
  return done ? out : null;
}

/**
 * The journal's MCP tools (served by src-tauri/src/mcp.rs on the Mac). The Rust side speaks MCP and
 * hands each tool call here; writes go through the store under the client's name, so they show in
 * Settings → AI changes and can be undone.
 */

declare global {
  interface Window {
    /** Saves what's being typed now (App.tsx), so a tool's write lands after it. */
    __journalFlush?: () => Promise<void>;
  }
}

export interface McpCall {
  id: number;
  tool: string;
  args: Record<string, unknown> | null;
  actor: string;
}

export interface McpResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const text = (t: string, isError = false): McpResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function runMcpTool(store: JournalStore, call: Pick<McpCall, "tool" | "args" | "actor">, now = new Date()): Promise<McpResult> {
  const args = call.args ?? {};
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const dayText = async (day: string) => {
    const page = await store.getDay(day);
    return page ? docText(page.content) : "";
  };
  switch (call.tool) {
    case "today": {
      const day = dayKey(now);
      return text(`# ${day}\n\n${(await dayText(day)) || "(nothing written yet today)"}`);
    }
    case "read_day": {
      const day = str("date");
      if (!DATE_RE.test(day)) return text("date must be YYYY-MM-DD", true);
      return text(`# ${day}\n\n${(await dayText(day)) || "(no page for this day)"}`);
    }
    case "read_page": {
      const page = await store.getPage(str("title"));
      return page ? text(`# ${page.title}\n\n${docText(page.content)}`) : text(`No page called "${str("title")}".`, true);
    }
    case "search": {
      const hits = (await store.search(str("query"))).flatMap((h) => (h.kind === "file" ? [] : [h])).slice(0, 20);
      if (!hits.length) return text("Nothing found.");
      return text(hits.map((h) => `## ${h.day ?? h.title}\n${h.text.slice(0, 600)}`).join("\n\n"));
    }
    case "list_days":
      return text((await store.listDays()).join("\n") || "(no days yet)");
    case "append": {
      const added = str("text").trim();
      if (!added) return text("text is empty", true);
      const day = str("date") || dayKey(now);
      if (!DATE_RE.test(day)) return text("date must be YYYY-MM-DD", true);
      await window.__journalFlush?.();
      const page = await store.getDay(day);
      const content = appendBlocks(page?.content ?? null, textBlocks(added));
      await store.saveDay({ day, content, plainText: docText(content), actor: call.actor || "MCP client" });
      window.dispatchEvent(new Event("journal:reload-page"));
      return text(`Added to ${day}. (Shown in the app under Settings → AI changes as "${call.actor}", where it can be undone.)`);
    }
    case "replace_text": {
      const find = str("find");
      if (!find) return text("find is empty", true);
      await window.__journalFlush?.();
      const actor = call.actor || "MCP client";
      if (str("title")) {
        const page = await store.getPage(str("title"));
        if (!page) return text(`No page called "${str("title")}".`, true);
        const content = replaceInDoc(page.content, find, str("replace"));
        if (!content) return text(`"${find}" isn't on ${page.title}.`, true);
        await store.savePage({ id: page.id, content, plainText: docText(content), actor });
        window.dispatchEvent(new Event("journal:reload-page"));
        return text(`Changed on ${page.title}.`);
      }
      const day = str("date") || dayKey(now);
      if (!DATE_RE.test(day)) return text("date must be YYYY-MM-DD", true);
      const page = await store.getDay(day);
      const content = page && replaceInDoc(page.content, find, str("replace"));
      if (!content) return text(`"${find}" isn't in ${day}.`, true);
      await store.saveDay({ day, content, plainText: docText(content), actor });
      window.dispatchEvent(new Event("journal:reload-page"));
      return text(`Changed in ${day}.`);
    }
    case "add_to_page": {
      const added = str("text").trim();
      const title = str("title").trim();
      if (!added || !title) return text("title and text are needed", true);
      await window.__journalFlush?.();
      const actor = call.actor || "MCP client";
      const page = await store.ensurePage(title, actor);
      const content = appendBlocks(page.content ?? null, textBlocks(added));
      await store.savePage({ id: page.id, content, plainText: docText(content), actor });
      window.dispatchEvent(new Event("journal:reload-page"));
      return text(`Added to ${page.title}.`);
    }
    case "save_graph": {
      const name = str("title").replace(/^Graph · /, "").trim().slice(0, 60);
      const d = parseLoadout(str("data"));
      if (!name) return text("title is empty", true);
      if (!d) return text("data has no graph in it (needs features, prompts and segs)", true);
      const actor = call.actor || "MCP client";
      const page = await store.ensurePage(`${GRAPH_PREFIX}${name}`, actor);
      // The summary line, not the JSON, is what links and tags are read from: prompts that mention
      // [[pages]] or #tags don't become backlinks.
      await store.savePage({ id: page.id, content: loadoutPageContent(d), plainText: `Graph: ${name} (${d.segs.length} nodes)`, actor });
      return text(`Saved "${GRAPH_PREFIX}${name}": ${d.segs.length} nodes on ${d.features.length} branches. Open any note's Canvas and pick it in the graph menu.`);
    }
    case "youtube_day": {
      const day = str("date");
      if (!DATE_RE.test(day)) return text("date must be YYYY-MM-DD", true);
      const saved = await saveYoutubeDay(store, day, str("data"), call.actor || "YouTube tracker");
      return typeof saved === "string" ? text(saved, true) : text(`Kept the YouTube digest for ${day}.`);
    }
    default: {
      const out = await runJournalTool(store, call.tool, args, call.actor || "MCP client", now);
      return out ? text(out.text, !!out.error) : text(`Unknown tool ${call.tool}`, true);
    }
  }
}

/** Every tool, as MCP lists them (the Rust server asks the page for this list). */
export function mcpToolList() {
  return [
    ...TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
    {
      name: "youtube_day",
      description: "From the YouTube tracker extension: one day's watching digest (JSON text: watches, useful, distraction, shorts, topics, usefulVideos, note). Shown in that day's preview card.",
      inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, data: { type: "string", description: "The digest as JSON text" } }, required: ["date", "data"] },
    },
  ];
}

const MCP_KEY = "dynamic-journal.mcp-enabled";
export const mcpAvailable = () => "__TAURI_INTERNALS__" in window && !window.JournalShare;
export function mcpEnabled(): boolean {
  try {
    return localStorage.getItem(MCP_KEY) === "1";
  } catch {
    return false;
  }
}

let unlisten: (() => void) | null = null;

/** Starts (or stops) the server and answers its tool calls with this store. */
export async function setMcpServer(store: JournalStore, on: boolean): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  try {
    localStorage.setItem(MCP_KEY, on ? "1" : "0");
  } catch {
    // The toggle just won't be remembered.
  }
  if (!on) {
    unlisten?.();
    unlisten = null;
    await invoke("mcp_stop");
    return;
  }
  if (!unlisten) {
    unlisten = await listen<McpCall>("mcp-call", async (e) => {
      const result = e.payload.tool === "__tools" ? { tools: mcpToolList() } : await runMcpTool(store, e.payload).catch((err) => text(err instanceof Error ? err.message : String(err), true));
      await invoke("mcp_reply", { id: e.payload.id, result });
    });
  }
  await invoke("mcp_start");
}
