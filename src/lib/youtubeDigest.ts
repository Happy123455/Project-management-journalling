// The YouTube tracker's daily digests (sent by the Chrome extension on the Mac through MCP's
// youtube_day), kept one page per month: "YouTube · 2026-11", a JSON block of {days: {date: digest}}.
// A page, so it syncs to the phone; the day's preview card reads it.
import type { JournalStore } from "../store";

export interface YoutubeDay {
  day: string;
  watches: number;
  useful: number;
  distraction: number;
  unlabelled: number;
  shorts: number;
  topics: { t: string; n: number }[];
  usefulVideos: { id: string; title: string; channel: string }[];
  note: string;
  focus: string[];
  rising: string[];
}

export const YOUTUBE_PREFIX = "YouTube · ";
const pageFor = (day: string) => `${YOUTUBE_PREFIX}${day.slice(0, 7)}`;

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const s = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A digest from the extension's JSON, cleaned (or an error message). */
export function cleanDigest(day: string, raw: unknown): YoutubeDay | string {
  let d: Record<string, unknown>;
  try {
    d = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  } catch {
    return "data isn't JSON";
  }
  if (!d || typeof d !== "object") return "data isn't a digest";
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    day,
    watches: n(d.watches),
    useful: n(d.useful),
    distraction: n(d.distraction),
    unlabelled: n(d.unlabelled),
    shorts: n(d.shorts),
    topics: arr(d.topics).slice(0, 8).map((t) => ({ t: s((t as { t?: unknown }).t, 40), n: n((t as { n?: unknown }).n) })).filter((t) => t.t),
    usefulVideos: arr(d.usefulVideos)
      .slice(0, 8)
      .map((v) => ({ id: s((v as { id?: unknown }).id, 20), title: s((v as { title?: unknown }).title, 120), channel: s((v as { channel?: unknown }).channel, 60) }))
      .filter((v) => /^[A-Za-z0-9_-]{6,20}$/.test(v.id)),
    note: s(d.note, 600),
    focus: arr(d.focus).slice(0, 3).map((f) => s(f, 40)).filter(Boolean),
    rising: arr(d.rising).slice(0, 4).map((f) => s(f, 40)).filter(Boolean),
  };
}

function readMonth(text: string | undefined): Record<string, YoutubeDay> {
  try {
    const j = JSON.parse(text ?? "{}");
    return j && typeof j.days === "object" && j.days ? j.days : {};
  } catch {
    return {};
  }
}
const monthText = (page: { content?: { content?: { content?: { text?: string }[] }[] } } | null) => page?.content?.content?.[0]?.content?.[0]?.text;

export async function saveYoutubeDay(store: JournalStore, day: string, data: unknown, actor: string): Promise<YoutubeDay | string> {
  const digest = cleanDigest(day, data);
  if (typeof digest === "string") return digest;
  const page = await store.ensurePage(pageFor(day), actor);
  const days = readMonth(monthText(page));
  if (JSON.stringify(days[day]) === JSON.stringify(digest)) return digest;
  days[day] = digest;
  const content = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: JSON.stringify({ days }) }] }] };
  await store.savePage({ id: page.id, content, plainText: `YouTube watching, ${day.slice(0, 7)}`, actor });
  window.dispatchEvent(new CustomEvent("journal:youtube-day", { detail: day }));
  return digest;
}

export async function loadYoutubeDay(store: JournalStore, day: string): Promise<YoutubeDay | null> {
  const page = await store.getPage(pageFor(day));
  return readMonth(monthText(page))[day] ?? null;
}

/** One line for the day's card: "📺 9 watched · 4 useful · 3 Shorts · linear algebra, cricket". */
export function youtubeLine(d: YoutubeDay): string {
  const parts = [`📺 ${d.watches} watched`];
  if (d.useful + d.distraction) parts.push(`${Math.round((d.useful / (d.useful + d.distraction)) * 100)}% useful`);
  if (d.shorts) parts.push(`${d.shorts} Short${d.shorts === 1 ? "" : "s"}`);
  if (d.topics.length) parts.push(d.topics.slice(0, 3).map((t) => t.t).join(", "));
  return parts.join(" · ");
}
