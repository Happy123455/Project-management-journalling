import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { askAi } from "../ai/client";
import { mediaNode } from "../editor/attachments";
import { appendBlocks, asBlocks } from "../lib/append";
import { extractTasks, setTaskChecked } from "../lib/projects";
import { todayAgenda } from "../lib/reminders";
import { dayKey, formatTimestamp } from "../lib/timestamp";
import { showToast } from "../lib/toast";
import { agendaAction } from "../routine/agenda";
import { changeDay, currentDoc, loadConfig, loadEntries, ROUTINE_EVENT, viewOf, writeLog } from "../routine/routineData";
import { EVENT_LOGGED } from "../store/logged";
import { FAV_EVENT, favouriteFormulas } from "./formulas";

/**
 * Galaxy Watch app (watch/ in the repo, Wear OS). The phone app is the watch's only link to the
 * journal: it publishes a small state (Watch.kt → /journal/state) and takes what the watch sends
 * (taps, notes, voice recordings) from Watch.kt's inbox, writing each into the journal like any edit.
 */

declare global {
  interface Window {
    JournalWatch?: { publish(json: string): void; take(): string; pending(): boolean };
  }
}

export interface WatchState {
  at: number;
  day: string;
  steps: { id: string; icon: string; label: string; span: boolean; running: boolean; done: boolean; next?: number }[];
  habits: { id: string; icon: string; label: string; today: number }[];
  agenda: { id: string; at: number; text: string; done: boolean }[];
  tasks: { day: string; path: number[]; text: string; done: boolean }[];
  projects: string[];
  formulas: { name: string; expr: string; lhs: string; vars: { name: string; value: number; step: number; label?: string }[] }[];
}

type Target = { kind: "today" } | { kind: "project"; title: string };
type InboxItem =
  | { t: "step"; id: string; at: number }
  | { t: "habit"; id: string; at: number }
  | { t: "agenda"; id: string; done: boolean; at: number }
  | { t: "task"; day: string; path: number[]; text: string; done: boolean; at: number }
  | { t: "note"; text: string; target: Target; at: number }
  | { t: "voice"; name: string; mime: string; data?: string; lost?: boolean; target: Target; transcribe?: boolean; at: number };

export async function watchState(store: JournalStore): Promise<WatchState> {
  const now = Date.now();
  const today = dayKey(new Date(now));
  const config = await loadConfig(store);
  const view = viewOf(config, await loadEntries(store, config, today, true), now);
  const sessions = (id: string) => (view.filled.get(id) ?? []).filter((s) => !s.estimated);
  const plan = new Map(view.plan.map((p) => [p.id, p.start]));
  const log = view.days.get(view.day);
  const [doc, page, reminders, projects] = await Promise.all([currentDoc(store, today), store.getDay(today), store.openReminders(), store.projects()]);
  const repeating = reminders.filter((r) => r.props.repeat).map((r) => ({ day: r.day, content: r.content, repeat: r.props.repeat, doneDays: r.props.doneDays }));
  return {
    at: now,
    day: today,
    steps: config.steps.map((s) => ({
      id: s.id,
      icon: s.icon,
      label: s.label,
      span: s.span,
      running: sessions(s.id).some((x) => x.open && !x.startGuessed),
      done: sessions(s.id).some((x) => !x.open),
      next: plan.get(s.id),
    })),
    habits: config.habits.map((h) => ({ id: h.id, icon: h.icon, label: h.label, today: log?.habits.get(h.id)?.length ?? 0 })),
    agenda: todayAgenda(doc ? { content: doc, reminder: !!page?.props.reminder } : null, repeating, today).map((a) => ({ id: a.id, at: a.at, text: a.text, done: a.done })),
    tasks: doc ? extractTasks(doc).filter((t) => t.text).slice(0, 40).map((t) => ({ day: today, path: t.path, text: t.text, done: t.checked })) : [],
    projects: projects.filter((p) => (p.props.project?.status ?? "active") === "active").map((p) => p.title).slice(0, 20),
    formulas: favouriteFormulas(),
  };
}

let publishTimer = 0;
let lastSent = "";
/** Sends the state to the watch a moment after things settle (edits, sync, routine taps). */
export function publishSoon(store: JournalStore, delay = 1500) {
  if (!window.JournalWatch) return;
  window.clearTimeout(publishTimer);
  publishTimer = window.setTimeout(() => {
    if (document.hidden) return;
    void watchState(store)
      .then((s) => {
        // Only a real change goes to the watch (each one wakes it).
        const key = JSON.stringify({ ...s, at: 0 });
        if (key === lastSent) return;
        lastSent = key;
        window.JournalWatch?.publish(JSON.stringify(s));
      })
      .catch(() => {});
  }, delay);
}

/** The ProseMirror position of the node at `path` (child indexes from the root). */
function posAt(doc: { child(i: number): { nodeSize: number } & unknown; childCount: number }, path: number[]): number | null {
  let node = doc as unknown as { child(i: number): unknown; childCount: number };
  let before = -1;
  for (const i of path) {
    if (i >= node.childCount) return null;
    let at = before + 1;
    for (let k = 0; k < i; k++) at += (node.child(k) as { nodeSize: number }).nodeSize;
    before = at;
    node = node.child(i) as typeof node;
  }
  return before;
}

/** Adds blocks to the end of a day's note (through its editor when it's open). */
function appendToDay(store: JournalStore, day: string, blocks: JSONContent[]) {
  return changeDay(
    store,
    day,
    (e) => e.chain().insertContentAt(e.state.doc.content.size, blocks).run(),
    (doc) => appendBlocks(doc, blocks),
  );
}

const para = (text: string, indent = 0): JSONContent => ({ type: "paragraph", ...(indent ? { attrs: { indent } } : {}), ...(text ? { content: [{ type: "text", text }] } : {}) });

async function transcribe(mime: string, data: string): Promise<string> {
  const a = await askAi({
    task: "describe",
    cloud: true,
    system: "Transcribe this voice note exactly as spoken, in the language spoken. Reply with only the text: no quotes, no notes, no timestamps.",
    text: "Transcribe this voice note.",
    images: [{ mime, data }],
    maxTokens: 2000,
  });
  return a.text.trim();
}

async function apply(store: JournalStore, item: InboxItem): Promise<string | null> {
  const today = dayKey(new Date());
  if (item.t === "step" || item.t === "habit") {
    const config = await loadConfig(store);
    const s = item.t === "step" ? config.steps.find((x) => x.id === item.id) : config.habits.find((x) => x.id === item.id);
    if (!s) return null;
    let edge: "start" | "end" | "point" = "point";
    if (item.t === "step" && "span" in s && s.span) {
      const state = await watchState(store);
      edge = state.steps.find((x) => x.id === s.id)?.running ? "end" : "start";
    }
    await writeLog(store, s, edge, new Date(item.at));
    return `${s.icon} ${s.label}${edge === "start" ? " started" : edge === "end" ? " done" : ""}`;
  }
  if (item.t === "agenda") {
    const doc = await currentDoc(store, today);
    const page = await store.getDay(today);
    const reminders = await store.openReminders();
    const repeating = reminders.filter((r) => r.props.repeat).map((r) => ({ day: r.day, content: r.content, repeat: r.props.repeat, doneDays: r.props.doneDays }));
    const a = todayAgenda(doc ? { content: doc, reminder: !!page?.props.reminder } : null, repeating, today).find((x) => x.id === item.id);
    if (!a || a.done === item.done) return null;
    await agendaAction(store, a, item.done ? "done" : "undo");
    return null;
  }
  if (item.t === "task") {
    const ok = await changeDay(
      store,
      item.day,
      (e) => {
        const pos = posAt(e.state.doc as never, item.path);
        const node = pos == null ? null : e.state.doc.nodeAt(pos);
        if (pos == null || node?.type.name !== "taskItem") return false;
        e.view.dispatch(e.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: item.done }));
        return true;
      },
      (doc) => {
        if (!doc) return null;
        const t = extractTasks(doc).find((x) => x.path.join(".") === item.path.join("."));
        return t && t.text === item.text ? setTaskChecked(doc, item.path, item.done) : null;
      },
    );
    return ok ? `${item.done ? "☑" : "☐"} ${item.text}` : null;
  }
  const head = formatTimestamp(new Date(item.at));
  const blocks: JSONContent[] = [];
  const project = item.target.kind === "project" ? item.target.title : null;
  if (project) blocks.push(para(`[[${project}]]`));
  const indent = project ? 1 : 0;
  if (item.t === "note") {
    blocks.push(para(`${head} ⌚ ${item.text}`, indent));
  } else {
    let text = "";
    if (item.data && item.transcribe !== false) text = await transcribe(item.mime, item.data).catch(() => "");
    blocks.push(para(`${head} ⌚🎙 ${text || (item.lost ? "(the recording didn't arrive)" : item.data ? "(couldn't transcribe: AI is off or offline)" : "")}`, indent));
    if (item.data) {
      const bytes = Uint8Array.from(atob(item.data), (c) => c.charCodeAt(0));
      const media = asBlocks([mediaNode(await store.saveFile({ name: item.name, mime: item.mime, bytes }))]);
      blocks.push(...media.map((b) => (indent && b.type === "paragraph" ? { ...b, attrs: { ...b.attrs, indent } } : b)));
    }
  }
  await appendToDay(store, today, blocks);
  return project ? `⌚ Added to ${project}` : "⌚ Added to today";
}

let taking = false;
/** Writes everything the watch sent into the journal. */
export async function takeWatchInbox(store: JournalStore): Promise<number> {
  if (!window.JournalWatch || taking) return 0;
  taking = true;
  let n = 0;
  try {
    const items = JSON.parse(window.JournalWatch.take() || "[]") as InboxItem[];
    for (const item of items) {
      try {
        const said = await apply(store, item);
        n++;
        if (said) showToast(said);
      } catch (e) {
        showToast(`⌚ Couldn't add something from the watch: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
    if (n) window.dispatchEvent(new Event(ROUTINE_EVENT));
  } finally {
    taking = false;
  }
  if (n) publishSoon(store, 300);
  return n;
}

/** Starts the watch link (Android only): inbox on arrival and on return, state after changes. */
export function startWatch(store: JournalStore): () => void {
  if (!window.JournalWatch) return () => {};
  const take = () => void takeWatchInbox(store);
  // Edits while writing: the watch is told once the writing pauses (cheap for the battery).
  const changed = () => publishSoon(store, 12_000);
  const tapped = () => publishSoon(store, 600);
  const onVisible = () => {
    if (document.hidden) return;
    take();
    publishSoon(store, 800);
  };
  window.addEventListener("journal:watch", take);
  window.addEventListener(EVENT_LOGGED, changed);
  window.addEventListener(ROUTINE_EVENT, tapped);
  window.addEventListener("journal:synced", changed);
  window.addEventListener(FAV_EVENT, tapped);
  document.addEventListener("visibilitychange", onVisible);
  take();
  publishSoon(store, 3000);
  return () => {
    window.removeEventListener("journal:watch", take);
    window.removeEventListener(EVENT_LOGGED, changed);
    window.removeEventListener(ROUTINE_EVENT, tapped);
    window.removeEventListener("journal:synced", changed);
    window.removeEventListener(FAV_EVENT, tapped);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
