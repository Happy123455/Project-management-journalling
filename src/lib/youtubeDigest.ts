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

// ───── What kind of watching (the 📺 pie charts) ─────

/** Purpose groups for the tracker's topics, by words in the topic. First match wins. */
export const YT_PURPOSES: [string, string, RegExp][] = [
  ["learning", "🎓 Learning", /\b(ai|ml|llm|gpt|chatgpt|claude|gemini|nvidia|engineers?|factory|manufacturing|explained|explainer|documentary|learn|learning|course|guide|machine learning|coding|programming|code|python|javascript|react|tech|technology|science|physics|chemistry|math|maths|engineering|civil|transport|study|exam|lecture|tutorial|how to|education|history|economics|finance|investing|stock|business|startup|productivity|design|language|english|research|space|astronomy|biology|medicine|health|psychology|philosophy)\b/i],
  ["news", "📰 News & talk", /\b(news|politics|election|podcast|interview|debate|current affairs|geopolitics|world|india|government|war)\b/i],
  ["motivation", "🔥 Motivation", /\b(motivation|motivational|self[- ]?improvement|discipline|mindset|success|habits?|stoic|stoicism|gym|fitness|workout|bodybuilding)\b/i],
  ["music", "🎵 Music", /\b(music|song|songs|lyrics|lofi|lo-fi|rap|bollywood music|cover|singing|concert|remix|beats?)\b/i],
  ["entertainment", "🎬 Entertainment", /\b(comedy|funny|meme|memes|prank|gaming|game|games|minecraft|gta|bgmi|pubg|anime|movie|movies|film|series|tv|reaction|vlog|celebrity|bollywood|hollywood|cartoon|kitten|kittens|cat|cats|dog|dogs|puppy|animals?|pets?|satisfying|asmr|dance|trend|trending|shorts|viral|drama|roast|magic|cricket|football|sports?|ipl|fails?|clips?|lol|skit|sketch|standup|stand-up|joke|jokes|troll|edit|edits|genshin|honkai|valorant|fortnite|roblox|podcast clips?|reels?|wwe|ufc|boxing)\b/i],
  ["lifestyle", "🍲 Lifestyle", /\b(food|cooking|recipe|travel|fashion|beauty|cars?|bikes?|diy|craft|home|vlog|shopping|unboxing|review)\b/i],
];

/** The purpose group of a topic ("other" when nothing fits). `own` = groups the AI or the person gave before. */
export function purposeOf(topic: string, own: Record<string, string> = {}): string {
  const t = topic.toLowerCase().trim();
  if (own[t]) return own[t];
  for (const [id, , re] of YT_PURPOSES) if (re.test(t)) return id;
  return "other";
}

export const purposeLabel = (id: string) => YT_PURPOSES.find((p) => p[0] === id)?.[1] ?? "❔ Other";

/** Every month page's digests between `from` and `to` (YYYY-MM-DD), oldest first. */
export async function loadYoutubeRange(store: JournalStore, from: string, to: string): Promise<YoutubeDay[]> {
  const out: YoutubeDay[] = [];
  const months = new Set<string>();
  for (let d = new Date(`${from.slice(0, 7)}-01T12:00:00`); d <= new Date(`${to}T12:00:00`); d.setMonth(d.getMonth() + 1)) months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  for (const m of months) {
    const days = readMonth(monthText(await store.getPage(`${YOUTUBE_PREFIX}${m}`)));
    for (const [day, digest] of Object.entries(days)) if (day >= from && day <= to) out.push(digest);
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export interface YoutubeMix {
  watches: number;
  shorts: number;
  /** Useful / entertainment (the tracker's own labels) / not labelled yet. */
  verdict: { id: string; label: string; n: number }[];
  /** Topic counts grouped by purpose (only the topics the tracker named; the rest is "unsorted"). */
  purposes: { id: string; label: string; n: number }[];
  /** The domains: topics themselves, biggest first. */
  topics: { t: string; n: number; purpose: string }[];
}

export function youtubeMix(days: YoutubeDay[], own: Record<string, string> = {}): YoutubeMix {
  const sum = (f: (d: YoutubeDay) => number) => days.reduce((a, d) => a + f(d), 0);
  const watches = sum((d) => d.watches);
  const topics = new Map<string, number>();
  for (const d of days) for (const t of d.topics) topics.set(t.t.toLowerCase(), (topics.get(t.t.toLowerCase()) ?? 0) + t.n);
  const byPurpose = new Map<string, number>();
  for (const [t, n] of topics) byPurpose.set(purposeOf(t, own), (byPurpose.get(purposeOf(t, own)) ?? 0) + n);
  const named = [...topics.values()].reduce((a, n) => a + n, 0);
  const purposes = [...byPurpose.entries()].map(([id, n]) => ({ id, label: purposeLabel(id), n })).sort((a, b) => b.n - a.n);
  if (watches > named) purposes.push({ id: "unsorted", label: "· Not sorted by topic", n: watches - named });
  return {
    watches,
    shorts: sum((d) => d.shorts),
    verdict: [
      { id: "useful", label: "🎓 Useful", n: sum((d) => d.useful) },
      { id: "distraction", label: "🎬 Entertainment / distraction", n: sum((d) => d.distraction) },
      { id: "unlabelled", label: "· Not labelled yet", n: sum((d) => d.unlabelled) },
    ].filter((v) => v.n > 0),
    purposes: purposes.filter((p) => p.n > 0),
    topics: [...topics.entries()].map(([t, n]) => ({ t, n, purpose: purposeOf(t, own) })).sort((a, b) => b.n - a.n),
  };
}
