import { appendBlocks, textBlocks } from "./lib/append";
import { dayKey } from "./lib/timestamp";
import { docText } from "./lib/words";
import type { JournalStore } from "./store";

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
    default:
      return text(`Unknown tool ${call.tool}`, true);
  }
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
      const result = await runMcpTool(store, e.payload).catch((err) => text(err instanceof Error ? err.message : String(err), true));
      await invoke("mcp_reply", { id: e.payload.id, result });
    });
  }
  await invoke("mcp_start");
}
