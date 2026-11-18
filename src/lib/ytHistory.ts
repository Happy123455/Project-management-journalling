import { purposeOf, YT_PURPOSES } from "./youtubeDigest";

/**
 * 📺 YouTube history (Hapi, 18 Nov): the watch history from a Google Takeout file ("My
 * Activity.json") or the Chrome extension's export, sorted into kinds, with counts, an estimate of
 * the time spent, and ❤ likes the journal remembers (more of the same kind is suggested).
 */
export interface YtWatch {
  /** Video id (or the url when there's none). */
  id: string;
  title: string;
  channel: string;
  /** When it was watched (ms). */
  at: number;
  short?: boolean;
}

export interface YtLike {
  id: string;
  title: string;
  channel: string;
  /** When it was liked (ms), when known. */
  at?: number;
}

export interface YtHistory {
  watches: YtWatch[];
  /** Likes found in the file (Takeout's "Liked …" lines). */
  likes: YtLike[];
}

const idOf = (url: string): string => {
  const m = /[?&]v=([\w-]{6,})|youtu\.be\/([\w-]{6,})|\/shorts\/([\w-]{6,})/.exec(url);
  return m ? (m[1] ?? m[2] ?? m[3]) : url;
};

/** Reads Takeout, the extension's export ({watches: [...]}, or a list), or our own saved file. */
export function parseHistory(json: unknown): YtHistory {
  const list: unknown[] = Array.isArray(json) ? json : Array.isArray((json as { watches?: unknown[] })?.watches) ? (json as { watches: unknown[] }).watches : Array.isArray((json as { history?: unknown[] })?.history) ? (json as { history: unknown[] }).history : [];
  const savedLikes = Array.isArray((json as { likes?: unknown[] })?.likes) ? ((json as { likes: YtLike[] }).likes) : [];
  const watches: YtWatch[] = [];
  const likes: YtLike[] = [...savedLikes];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    // Takeout: {title: "Watched …", titleUrl, subtitles: [{name}], time, details: [{name: "From Google Ads"}]}
    if (typeof o.title === "string" && typeof o.time === "string" && /^(Watched|Liked|Viewed) /.test(o.title)) {
      if (Array.isArray(o.details) && o.details.length) continue; // ads
      const url = String(o.titleUrl ?? "");
      if (!url) continue;
      const kind = o.title.split(" ")[0];
      const title = o.title.replace(/^(Watched|Liked|Viewed) /, "").trim();
      const channel = String((o.subtitles as { name?: string }[] | undefined)?.[0]?.name ?? "");
      if (kind === "Liked") {
        const at = Date.parse(o.time);
        likes.push({ id: idOf(url), title, channel, ...(Number.isFinite(at) ? { at } : {}) });
        continue;
      }
      if (kind !== "Watched") continue;
      const at = Date.parse(o.time);
      if (!Number.isFinite(at)) continue;
      const w: YtWatch = { id: idOf(url), title, channel, at, ...(/\/shorts\//.test(url) ? { short: true } : {}) };
      const k = `${w.id}|${Math.round(at / 60000)}`;
      if (!seen.has(k)) seen.add(k), watches.push(w);
      continue;
    }
    // The extension / our own file: {id|videoId, title, channel, at|watchedAt|timestamp|time, isShort}
    const id = String(o.id ?? o.videoId ?? (typeof o.url === "string" ? idOf(o.url) : "") ?? "");
    const t = o.at ?? o.watchedAt ?? o.timestamp ?? o.time ?? o.date;
    const at = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(String(t ?? ""));
    if (!id || !Number.isFinite(at) || typeof o.title !== "string") continue;
    const w: YtWatch = { id, title: o.title, channel: String(o.channel ?? o.channelName ?? o.author ?? ""), at, ...(o.short || o.isShort || o.channel === "YouTube Shorts" ? { short: true } : {}) };
    const k = `${w.id}|${Math.round(at / 60000)}`;
    if (!seen.has(k)) seen.add(k), watches.push(w);
  }
  const likeIds = new Set<string>();
  return { watches: watches.sort((a, b) => a.at - b.at), likes: likes.filter((l) => !likeIds.has(l.id) && (likeIds.add(l.id), true)) };
}

/** The last `days` days of the history (counted back from its newest watch). */
export function lastDays(watches: YtWatch[], days: number): YtWatch[] {
  if (!watches.length) return [];
  const end = watches[watches.length - 1].at;
  const from = end - days * 86400000;
  return watches.filter((w) => w.at > from);
}

/**
 * About how long each video was watched: the time until the next one started, when that's under
 * 40 minutes (a short: up to 1.5). After a longer gap (the phone was put down) it counts as the usual
 * length. An estimate: Takeout has no durations.
 */
export function watchMinutes(watches: YtWatch[]): number[] {
  const gaps = watches.map((w, i) => (i + 1 < watches.length ? (watches[i + 1].at - w.at) / 60000 : null));
  const known = gaps.filter((g): g is number => g !== null && g > 0 && g <= 40).sort((a, b) => a - b);
  const usual = known.length ? Math.min(10, known[Math.floor(known.length / 2)]) : 4;
  return gaps.map((g, i) => {
    const cap = watches[i].short ? 1.5 : 40;
    if (g === null || g <= 0 || g > 40) return Math.min(cap, usual);
    return Math.min(cap, g);
  });
}

export const CATEGORY_IDS = [...YT_PURPOSES.map((p) => p[0]), "other"];

/** Its kind: what was set for its channel, else the words of its title and channel. */
export function categoryOf(w: { title: string; channel: string }, channelKinds: Record<string, string> = {}): string {
  const own = channelKinds[w.channel.toLowerCase()];
  if (own) return own;
  // YouTube's auto music channels ("HOYO-MiX - Topic"), and clip/short channels.
  if (/\s-\sTopic$/i.test(w.channel) || /\b(?:vevo|records|official audio|ost|soundtrack|lyric video)\b/i.test(`${w.channel} ${w.title}`)) return "music";
  const byTitle = purposeOf(w.title);
  if (byTitle !== "other") return byTitle;
  const byChannel = purposeOf(w.channel);
  if (byChannel !== "other") return byChannel;
  // Space and "what if" science explainers.
  if (/\b(universe|black holes?|galax(?:y|ies)|milky way|neutron stars?|planets?|nasa|what if|3d scans?|lidar|robots?|robotics|tesla|engineering)\b/i.test(w.title)) return "learning";
  // Short clips: laughing/crying emoji, a #hashtag, "POV", "bro"…
  if (/[😂🤣😭💀🥀😆😹]|(^|\s)#\w|\bpov\b|\bbro\b|\bmemes?\b|\bsnl\b/iu.test(w.title)) return "entertainment";
  return "other";
}

const STOP = new Set("the a an and or of to in on for with is are was this that how what why your you my i me we it its from at by be not no new vs video official full part episode ep shorts short".split(" "));
const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));

/**
 * "More like what you ❤": videos not liked yet, scored by how close they are to the liked ones
 * (same channel counts most, then shared title words, then the same kind).
 */
export function likeScores(watches: YtWatch[], likes: YtLike[], channelKinds: Record<string, string> = {}): Map<string, number> {
  const liked = new Set(likes.map((l) => l.id));
  const ch = new Map<string, number>();
  const wd = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const l of likes) {
    if (l.channel) ch.set(l.channel.toLowerCase(), (ch.get(l.channel.toLowerCase()) ?? 0) + 1);
    for (const w of new Set(words(l.title))) wd.set(w, (wd.get(w) ?? 0) + 1);
    const k = categoryOf(l, channelKinds);
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  if (!likes.length) return out;
  for (const w of watches) {
    if (liked.has(w.id) || out.has(w.id)) continue;
    let s = (ch.get(w.channel.toLowerCase()) ?? 0) * 3;
    for (const x of new Set(words(w.title))) s += Math.min(2, wd.get(x) ?? 0);
    s += ((kinds.get(categoryOf(w, channelKinds)) ?? 0) / likes.length) * 1.5;
    if (s >= 2) out.set(w.id, s);
  }
  return out;
}

export interface YtStats {
  videos: number;
  unique: number;
  minutes: number;
  shorts: number;
  days: { day: string; n: number; minutes: number }[];
  hours: number[];
  categories: { id: string; n: number; minutes: number }[];
  channels: { channel: string; n: number; minutes: number }[];
}

const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function ytStats(watches: YtWatch[], channelKinds: Record<string, string> = {}): YtStats {
  const mins = watchMinutes(watches);
  const days = new Map<string, { n: number; minutes: number }>();
  const cats = new Map<string, { n: number; minutes: number }>();
  const chans = new Map<string, { channel: string; n: number; minutes: number }>();
  const hours = Array(24).fill(0);
  watches.forEach((w, i) => {
    const d = dayOf(w.at);
    const a = days.get(d) ?? { n: 0, minutes: 0 };
    a.n++;
    a.minutes += mins[i];
    days.set(d, a);
    const k = categoryOf(w, channelKinds);
    const c = cats.get(k) ?? { n: 0, minutes: 0 };
    c.n++;
    c.minutes += mins[i];
    cats.set(k, c);
    const key = w.channel.toLowerCase() || "(no channel)";
    const h = chans.get(key) ?? { channel: w.channel || "(no channel)", n: 0, minutes: 0 };
    h.n++;
    h.minutes += mins[i];
    chans.set(key, h);
    hours[new Date(w.at).getHours()]++;
  });
  return {
    videos: watches.length,
    unique: new Set(watches.map((w) => w.id)).size,
    minutes: mins.reduce((a, b) => a + b, 0),
    shorts: watches.filter((w) => w.short).length,
    days: [...days.entries()].sort().map(([day, v]) => ({ day, ...v })),
    hours,
    categories: [...cats.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.n - a.n),
    channels: [...chans.values()].sort((a, b) => b.n - a.n),
  };
}

/** The ❤ page's lines ("❤ Title — Channel · https://youtu.be/id") → likes, and back. */
export const LIKES_PAGE = "YouTube likes";
export const likeLine = (l: YtLike) => `❤ ${l.title.replace(/\s+/g, " ").trim()}${l.channel ? ` — ${l.channel}` : ""} · https://youtu.be/${l.id}`;
export function likesFromText(text: string): YtLike[] {
  const out: YtLike[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*❤\s*(.+?)(?:\s+—\s+(.+?))?\s+·\s+https:\/\/youtu\.be\/([\w-]+)\s*$/.exec(line);
    if (m) out.push({ title: m[1], channel: m[2] ?? "", id: m[3] });
  }
  return out;
}
