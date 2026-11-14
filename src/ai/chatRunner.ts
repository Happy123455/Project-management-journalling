import type { JournalStore } from "../store";
import { askAi, localAvailable } from "./client";
import { coolGenerate, isChatml, type CoolLevel, type CoolProgress, type LocalMessage } from "./local";
import { agentSystem, parseToolCalls, runTools } from "./agent";
import { loadAiSettings, modelFor, recordUsage } from "./settings";
import { actorFor } from "./providers";
import type { Section } from "./blocks";
import { showToast } from "../lib/toast";
import { holdAwake } from "../lib/power";

/**
 * AI chats and the one job that answers them, outside any screen: a reply keeps going while the
 * person writes notes, and a small 🤖 badge shows it (src/AiBadge.tsx). Chats are journal pages
 * ("AI chat data · <id>"), so they sync: the phone saves a message marked `pending` and the Mac's
 * worker answers it with its local model, then the answer syncs back. One job at a time, so the
 * Mac never runs two at once (heat).
 */

export interface Step {
  kind: "thought" | "tool";
  text: string;
}
export interface Msg {
  role: "user" | "assistant";
  content: string;
  /** The reasoning in order: thoughts and the tools used between them. */
  steps?: Step[];
  kind?: "map" | "evolution";
  by?: string;
}
export interface Chat {
  id: string;
  title: string;
  messages: Msg[];
  updated: number;
  /** May read and change the journal (tools). */
  edit?: boolean;
  /** Only this part of a note may be changed. */
  section?: Section | null;
  /** Waiting for the Mac: what to run (sent from the phone). */
  pending?: { ask?: string; kind?: Msg["kind"]; at: number } | null;
}

const PREFIX = "AI chat data · ";
export const chatPage = (id: string) => PREFIX + id;
export const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", messages: [], updated: Date.now() });

function fromPage(text: string | undefined): Chat | null {
  try {
    const c = text ? (JSON.parse(text) as Chat) : null;
    return c?.id ? c : null;
  } catch {
    return null;
  }
}

export async function loadChat(store: JournalStore, id: string): Promise<Chat | null> {
  const page = await store.getPage(chatPage(id));
  return fromPage(page?.content?.content?.[0]?.content?.[0]?.text);
}

export async function saveChat(store: JournalStore, chat: Chat, actor = "me") {
  const page = await store.ensurePage(chatPage(chat.id), actor);
  const content = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: JSON.stringify(chat) }] }] };
  await store.savePage({ id: page.id, content, plainText: `AI chat: ${chat.title}`, actor });
  emit();
}

/** Every chat, newest first. */
export async function listChats(store: JournalStore): Promise<Chat[]> {
  const names = (await store.pageNames()).filter((n) => n.startsWith(PREFIX));
  const chats = await Promise.all(names.map((n) => loadChat(store, n.slice(PREFIX.length))));
  return chats.filter((c): c is Chat => !!c).sort((a, b) => b.updated - a.updated);
}

/** Moves the chats kept on this device before chats synced (first version) into the journal. */
export async function migrateLocalChats(store: JournalStore) {
  try {
    const old = JSON.parse(localStorage.getItem("dynamic-journal.ai-chats") ?? "[]") as Chat[];
    if (!old.length) return;
    for (const c of old) {
      const messages = c.messages.map((m) => {
        const t = (m as Msg & { thinking?: string; tools?: string[] });
        return { ...m, steps: t.thinking ? [{ kind: "thought" as const, text: t.thinking }] : undefined, thinking: undefined, tools: undefined };
      });
      await saveChat(store, { ...c, messages });
    }
    localStorage.removeItem("dynamic-journal.ai-chats");
  } catch {
    // Left where it was; tried again next time.
  }
}

// ───── The running job ─────

export interface Job {
  chatId: string;
  title: string;
  progress: CoolProgress | null;
  /** The phone: waiting for the Mac to answer. */
  remote?: boolean;
}
let job: Job | null = null;
const queue: (() => Promise<void>)[] = [];
let stopper: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const currentJob = () => job;
export function subscribeJob(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const stopJob = () => stopper?.abort();
export const isMac = () => "__TAURI_INTERNALS__" in window && !window.JournalShare;

/** Rests in the native side on the Mac (a hidden window's timers are slowed by macOS). */
async function rest(ms: number, signal?: AbortSignal) {
  const wait = isMac() ? (await import("@tauri-apps/api/core")).invoke("ai_rest", { ms }) : new Promise((r) => setTimeout(r, ms));
  await Promise.race([wait, new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }))]);
}

const MAP_ASK =
  "Summarise our whole conversation as a mind map. Answer only with a Markdown bullet outline: one root bullet naming the topic, " +
  "then the main branches indented under it, then their details indented further (at most 4 levels, short phrases).";
const EVOLUTION_ASK =
  "Summarise how the logic of our conversation evolved: where we started, each turn the thinking took (what changed it), " +
  "and where we ended up. Use short numbered stages, then one line: Started → Ended.";
export const askFor = (kind?: Msg["kind"]) => (kind === "map" ? MAP_ASK : kind === "evolution" ? EVOLUTION_ASK : undefined);

/** One answer: with editing on, the model may call tools first (a few rounds). */
async function answer(store: JournalStore, chat: Chat, ask: string | undefined, cool: CoolLevel, signal: AbortSignal, onProgress: (p: CoolProgress) => void): Promise<{ msg: Msg; section?: Section | null }> {
  const settings = loadAiSettings();
  const model = modelFor({ ...settings, provider: "local" }, "chat");
  const msgs: LocalMessage[] = chat.messages.filter((m) => !m.kind).map((m) => ({ role: m.role, content: m.content }));
  if (ask) msgs.push({ role: "user", content: ask });
  if (!(settings.enabled && (await localAvailable())) || !isChatml(model)) {
    // No local model here (or not a Qwen one): one plain request with the transcript, no tools.
    const text = msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n") + "\n\nAssistant:";
    const a = await askAi({ task: "chat", system: "", text, maxTokens: 6000 });
    return { msg: { role: "assistant", content: a.text.trim(), by: a.actor } };
  }
  const actor = actorFor("local", model);
  const tools = chat.edit && !ask;
  const steps: Step[] = [];
  let section = chat.section;
  if (tools) msgs.unshift({ role: "system", content: agentSystem(section) });
  for (let round = 0; round < 8; round++) {
    const out = await coolGenerate({ model, messages: msgs, level: cool, signal, rest, onProgress: (p) => onProgress({ ...p, thinking: [...steps.map((s) => s.text), p.thinking].join("\n\n") }) });
    recordUsage(model, 0, out.tokens);
    if (out.thinking) steps.push({ kind: "thought", text: out.thinking });
    const { calls, text } = tools ? parseToolCalls(out.answer) : { calls: [], text: out.answer };
    if (!calls.length) return { msg: { role: "assistant", content: text, steps: steps.length ? steps : undefined, by: actor }, section };
    if (text) steps.push({ kind: "thought", text });
    const r = await runTools(store, calls, actor, section);
    section = r.section;
    steps.push(...r.log.map((l) => ({ kind: "tool" as const, text: l })));
    msgs.push({ role: "assistant", content: out.answer }, r.message);
  }
  return { msg: { role: "assistant", content: "(Stopped after several tool rounds.)", steps, by: actor }, section };
}

/** Answers the chat's last message (or `kind`'s summary) in the background; one job at a time. */
export function startAnswer(store: JournalStore, chatId: string, kind?: Msg["kind"]): void {
  const run = async () => {
    const chat = await loadChat(store, chatId);
    if (!chat) return;
    job = { chatId, title: chat.title, progress: null };
    emit();
    stopper = new AbortController();
    const release = holdAwake();
    try {
      const cool = loadAiSettings().cool ?? "cool";
      const { msg, section } = await answer(store, chat, askFor(kind), cool, stopper.signal, (p) => {
        if (job) job = { ...job, progress: p };
        emit();
      });
      // Read again: the person may have changed the chat (or its section) meanwhile.
      const now = (await loadChat(store, chatId)) ?? chat;
      await saveChat(store, { ...now, messages: [...now.messages, { ...msg, kind }], section: section ?? now.section, pending: null, updated: Date.now() });
      showToast(`🤖 Answer ready: ${chat.title}`, "info", { label: "Open", run: () => window.dispatchEvent(new CustomEvent("journal:open-ai-chat", { detail: chatId })) }, { background: true });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) showToast(`No AI reply: ${e instanceof Error ? e.message : String(e)}`, "error", undefined, { background: true });
      const now = await loadChat(store, chatId);
      if (now?.pending) await saveChat(store, { ...now, pending: null });
    } finally {
      release();
      stopper = null;
      job = null;
      emit();
      const next = queue.shift();
      if (next) void next();
    }
  };
  if (job) queue.push(run);
  else void run();
}

/**
 * Sends a message: on the Mac it's answered here; on the phone it's marked pending for the Mac
 * (when "Answer on my Mac" is on), and this device watches for the answer.
 */
export async function sendMessage(store: JournalStore, chat: Chat, text: string | null, kind?: Msg["kind"], onMac = !isMac()) {
  const messages = text ? [...chat.messages, { role: "user" as const, content: text }] : chat.messages;
  const next: Chat = { ...chat, title: chat.messages.length || !text ? chat.title : text.slice(0, 48), messages, updated: Date.now(), pending: onMac ? { kind, at: Date.now() } : null };
  await saveChat(store, next);
  if (!onMac) startAnswer(store, chat.id, kind);
  else watchRemote(store, next);
  return next;
}

let watching: number | null = null;
/** The phone: shows the badge until the Mac's answer has synced back. */
export function watchRemote(store: JournalStore, chat: Chat) {
  if (job?.chatId === chat.id) return;
  job = { chatId: chat.id, title: chat.title, progress: null, remote: true };
  emit();
  if (watching) clearInterval(watching);
  const started = Date.now();
  watching = window.setInterval(async () => {
    const now = await loadChat(store, chat.id);
    if (now && !now.pending) {
      clearInterval(watching!);
      watching = null;
      job = null;
      emit();
      showToast(`🤖 Answer ready: ${now.title}`, "info", { label: "Open", run: () => window.dispatchEvent(new CustomEvent("journal:open-ai-chat", { detail: chat.id })) }, { background: true });
    } else if (Date.now() - started > 3 * 3600_000) {
      clearInterval(watching!);
      watching = null;
      job = null;
      emit();
    }
  }, 5000);
}
export function stopWatching(store: JournalStore, chatId: string) {
  if (watching) clearInterval(watching);
  watching = null;
  job = null;
  emit();
  void loadChat(store, chatId).then((c) => c?.pending && saveChat(store, { ...c, pending: null }));
}

/** The Mac: answers chats the phone left pending (checked every 15 s). */
export function startMacWorker(store: JournalStore): () => void {
  const seen = new Set<string>();
  const check = async () => {
    for (const c of await listChats(store)) {
      if (!c.pending || seen.has(`${c.id}:${c.pending.at}`)) continue;
      seen.add(`${c.id}:${c.pending.at}`);
      startAnswer(store, c.id, c.pending.kind);
    }
  };
  void migrateLocalChats(store).then(check);
  const t = window.setInterval(() => void check(), 15_000);
  return () => clearInterval(t);
}
