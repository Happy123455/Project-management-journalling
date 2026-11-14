// 📦 A whole project for another AI: the project page, every note about it, how it was edited
// (by Hapi and by AIs), the AI chats about it, its photos and recordings, and the project as a
// graph in the one graph format ({ features, prompts, segs } at the top), so Canvas and the mind
// map open the export too. Built without any AI call (free, instant).
import type { JSONContent } from "@tiptap/react";
import type { JournalEvent, JournalStore, NamedPage } from "../store";
import type { Chat } from "../ai/chatRunner";
import { eventDocument } from "../sync/merge";
import { GRAPH_PREFIX, parseLoadout, type PromptMapData } from "./canvasLoadout";
import { addFeatures, addPrompt, emptyGraph, localIso } from "./graphFormat";
import { entryFor } from "./projectDays";
import { docText } from "./words";

export const EXPORT_FORMAT = "dynamic-journal.project-export/1";

export interface ProjectExport extends PromptMapData {
  format: string;
  title: string;
  exportedAt: string;
  /** What this file is, for the AI that reads it. */
  prompt: string;
  page: { text: string; updatedAt: string; status?: string };
  notes: { day: string; text: string }[];
  edits: { at: string; actor: string; where: string; added: string[]; removed: string[] }[];
  chats: { title: string; updated: string; messages: { role: string; by?: string; text: string }[] }[];
  media: { id: string; name: string; mime: string; size: number; where: string; file?: string }[];
}

const MEDIA = new Set(["attachmentImage", "attachmentMedia", "attachmentFile"]);

/** File ids of the photos, videos, recordings and files in some blocks. */
export function fileIdsIn(nodes: JSONContent[] | undefined, out = new Set<string>()): Set<string> {
  for (const n of nodes ?? []) {
    if (n.type && MEDIA.has(n.type) && typeof n.attrs?.fileId === "string") out.add(n.attrs.fileId);
    fileIdsIn(n.content, out);
  }
  return out;
}

const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);

/** Lines added and removed between two texts (as sets of lines, which is what a reader needs). */
export function lineDiff(before: string, after: string, limit = 20): { added: string[]; removed: string[] } {
  const a = lines(before);
  const b = lines(after);
  // Each line of one side not matched by an equal line of the other (repeats count).
  const missing = (from: string[], other: string[]) => {
    const left = other.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
    return from.filter((x) => {
      const n = left.get(x) ?? 0;
      if (n > 0) left.set(x, n - 1);
      return n === 0;
    });
  };
  const added = missing(b, a);
  const removed = missing(a, b);
  const clip = (xs: string[]) => xs.slice(0, limit).map((x) => x.slice(0, 300));
  return { added: clip(added), removed: clip(removed) };
}

const textOf = (raw: string | null) => {
  if (!raw) return "";
  try {
    return docText(eventDocument(raw));
  } catch {
    return "";
  }
};

/**
 * Edits as a reader wants them: saves by the same person within 15 minutes are one edit, shown
 * as the lines it added and removed. `keep` limits the lines to the project's (for days).
 */
export function editsFrom(events: JournalEvent[], where: string, keep?: (line: string) => boolean): ProjectExport["edits"] {
  const sorted = events.filter((e) => e.op === "create" || e.op === "update" || e.op === "restore").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out: ProjectExport["edits"] = [];
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i];
    let last = first;
    while (i + 1 < sorted.length && sorted[i + 1].actor === first.actor && Date.parse(sorted[i + 1].createdAt) - Date.parse(last.createdAt) < 15 * 60_000) last = sorted[++i];
    i++;
    const d = lineDiff(textOf(first.before), textOf(last.after));
    const added = keep ? d.added.filter(keep) : d.added;
    const removed = keep ? d.removed.filter(keep) : d.removed;
    if (added.length || removed.length) out.push({ at: last.createdAt, actor: first.actor, where, added, removed });
  }
  return out;
}

const words = (t: string) => new Set((t.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !STOP.has(w)));
const STOP = new Set(["that", "this", "with", "from", "have", "will", "what", "when", "then", "they", "them", "there", "about", "into", "just", "also", "some", "more", "like", "need", "should", "would", "could"]);

/** The page's sections: its text split at headings (the part before the first heading is "Page"). */
function sections(page: NamedPage): { label: string; lines: string[] }[] {
  const out: { label: string; lines: string[] }[] = [{ label: "Page", lines: [] }];
  for (const n of page.content?.content ?? []) {
    const t = docText(n).trim();
    if (!t) continue;
    if (n.type === "heading") out.push({ label: t.slice(0, 60), lines: [] });
    else out[out.length - 1].lines.push(...lines(t));
  }
  return out.filter((s) => s.lines.length || s.label !== "Page");
}

/** Everything about one project, ready for an AI. Files are listed; `bytesFor` reads the ones to include. */
export async function buildProjectExport(store: JournalStore, page: NamedPage, chats: Chat[], now = new Date()): Promise<ProjectExport> {
  const title = page.title;
  const lower = title.toLowerCase();
  const pageText = docText(page.content);

  // Notes: every day's lines about the project, oldest first.
  const refs = (await store.references("wikilink", title)).filter((r) => r.day);
  const entries = refs
    .map((r) => ({ ref: r, entry: entryFor(r.day!, r.content as never, title) }))
    .filter((x) => x.entry)
    .sort((a, b) => a.ref.day!.localeCompare(b.ref.day!));
  const notes = entries.map(({ entry }) => ({ day: entry!.day, text: entry!.lines.join("\n") }));

  // Edits: the page's, and the project's lines on those days.
  const edits = editsFrom(await store.eventsFor(page.id), `page: ${title}`);
  for (const { ref, entry } of entries) {
    const mine = new Set(entry!.lines.flatMap(lines));
    const keep = (l: string) => mine.has(l) || l.toLowerCase().includes(`[[${lower}`);
    edits.push(...editsFrom(await store.eventsFor(ref.blockId), `day: ${ref.day}`, keep));
  }
  edits.sort((a, b) => a.at.localeCompare(b.at));

  // AI chats about it: limited to the project page, or talking about it.
  const about = chats.filter((c) => c.section?.title === title || c.title.toLowerCase().includes(lower) || c.messages.some((m) => m.content.toLowerCase().includes(lower)));
  const chatOut = about.map((c) => ({
    title: c.title,
    updated: new Date(c.updated).toISOString(),
    messages: c.messages.map((m) => ({ role: m.role, ...(m.by ? { by: m.by } : {}), text: m.content })),
  }));

  // Media in the page and the notes.
  const where = new Map<string, string>();
  for (const id of fileIdsIn(page.content?.content)) where.set(id, `page: ${title}`);
  for (const { entry } of entries) for (const id of fileIdsIn(entry!.doc)) if (!where.has(id)) where.set(id, `day: ${entry!.day}`);
  const media: ProjectExport["media"] = [];
  for (const [id, w] of where) {
    const f = await store.getFile(id);
    if (f) media.push({ id, name: f.name, mime: f.mime, size: f.size, where: w });
  }

  // The graph: the page's sections as branches, each note line on the section it shares the most
  // words with (or "Notes"), chats on their own branch, and a voice graph of the same name merged in.
  const secs = sections(page);
  let graph = emptyGraph(title);
  const secIds = addFeatures(graph, secs.map((s) => `📄 ${s.label}`));
  graph = secIds.graph;
  const withNotes = addFeatures(graph, ["📅 Notes"]);
  graph = withNotes.graph;
  const notesId = withNotes.ids[0];
  const secWords = secs.map((s) => words(`${s.label} ${s.lines.join(" ")}`));
  if (secs.length) {
    const pageLines = secs.flatMap((s) => s.lines);
    const ids = secs.flatMap((s, i) => s.lines.map(() => secIds.ids[i]));
    graph = addPrompt(graph, { at: new Date(page.updatedAt), thread: "📄 Project page", ideas: pageLines, branchIds: ids, sep: "\n" });
  }
  for (const n of notes) {
    const ls = lines(n.text);
    const ids = ls.map((l) => {
      const w = words(l);
      let best = -1;
      let score = 1;
      secWords.forEach((sw, i) => {
        let shared = 0;
        for (const x of w) if (sw.has(x)) shared++;
        if (shared > score) [best, score] = [i, shared];
      });
      return best >= 0 ? secIds.ids[best] : notesId;
    });
    graph = addPrompt(graph, { at: new Date(`${n.day}T12:00:00`), thread: "📅 Notes", ideas: ls, branchIds: ids, sep: "\n" });
  }
  if (chatOut.length) {
    const withChats = addFeatures(graph, ["💬 AI chats"]);
    graph = withChats.graph;
    const chatId = withChats.ids[0];
    for (const c of about) {
      const asked = c.messages.filter((m) => m.role === "user" && m.content.trim());
      if (asked.length) graph = addPrompt(graph, { at: new Date(c.updated), thread: `💬 ${c.title}`, ideas: asked.map((m) => m.content.trim()), branchIds: asked.map(() => chatId), sep: "\n\n" });
    }
  }
  const voicePage = await store.getPage(`${GRAPH_PREFIX}${title}`);
  const voice = voicePage ? parseLoadout(voicePage.content?.content?.[0]?.content?.[0]?.text ?? "") : null;
  if (voice) {
    const added = addFeatures(graph, voice.features.map((f) => f.label));
    graph = added.graph;
    const idOf = new Map(voice.features.map((f, i) => [f.id, added.ids[i]]));
    const offset = graph.prompts.length;
    graph = { ...graph, prompts: [...graph.prompts, ...voice.prompts], segs: [...graph.segs, ...voice.segs.map((s) => ({ ...s, p: s.p + offset, f: idOf.get(s.f) ?? s.f }))] };
  }
  // Branches nothing landed on are left out.
  const used = new Set(graph.segs.map((s) => s.f));
  graph = { ...graph, features: graph.features.filter((f) => used.has(f.id)) };

  const prompt =
    `This is the full export of the project "${title}" from Hapi's journal (Dynamic Journal), made ${localIso(now)}. ` +
    `"page" is the project's own page. "notes" are the dated journal lines about it, oldest first. ` +
    `"edits" is how it changed over time: who ("me" is Hapi, any other name is an AI) added or removed which lines, and when. ` +
    `"chats" are AI conversations about it. "media" lists its photos, videos, recordings and files (in the media folder next to this file when included). ` +
    `"features", "prompts" and "segs" are the same project as a graph: features are branches, prompts are dated items (the page, each day's notes, chat questions, voice talks), segs are their parts, each on a branch. ` +
    `Use all of it as context for what Hapi asks next.`;

  return {
    format: EXPORT_FORMAT,
    title,
    exportedAt: now.toISOString(),
    prompt,
    page: { text: pageText, updatedAt: page.updatedAt, ...(page.props.project?.status ? { status: page.props.project.status } : {}) },
    notes,
    edits,
    chats: chatOut,
    media,
    features: graph.features,
    prompts: graph.prompts,
    segs: graph.segs,
  };
}

/** The export as readable Markdown (to paste into any AI chat). */
export function exportMarkdown(x: ProjectExport): string {
  const out = [`# ${x.title}`, "", x.prompt, "", "## Project page", "", x.page.text.trim() || "(empty)", "", "## Notes", ""];
  for (const n of x.notes) out.push(`### ${n.day}`, "", n.text, "");
  if (x.chats.length) {
    out.push("## AI chats", "");
    for (const c of x.chats) {
      out.push(`### ${c.title}`, "");
      for (const m of c.messages) out.push(`**${m.role === "user" ? "Hapi" : m.by || "AI"}:** ${m.text}`, "");
    }
  }
  if (x.edits.length) {
    out.push("## Edit history", "");
    for (const e of x.edits) out.push(`- ${e.at.slice(0, 16).replace("T", " ")} · ${e.actor} · ${e.where}: ${[...e.added.map((l) => `+ ${l}`), ...e.removed.map((l) => `− ${l}`)].join(" | ")}`);
    out.push("");
  }
  if (x.media.length) {
    out.push("## Media", "");
    for (const m of x.media) out.push(`- ${m.file ?? m.name} (${m.mime}, ${Math.round(m.size / 1024)} KB, ${m.where})`);
  }
  return out.join("\n");
}
