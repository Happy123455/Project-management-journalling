import type { JSONContent } from "@tiptap/react";
import { plainLinks, plainText } from "./plainText";
import { dayKey, MONTHS, TIMESTAMP_RE } from "./timestamp";

/**
 * Canvas: a note shown as a mind map that grows over time. The note's lines become nodes, placed
 * in the column of the day (or, for a single day, the hour) they were written, on the row of the
 * branch they belong to. This file is the pure part: lines out of a note, when each was written,
 * how they're grouped into branches, and where everything sits. src/canvas draws it.
 */

export interface CanvasItem {
  /** Stable key: its first block's line id, or its day and words. */
  key: string;
  /** What's written (links as names, timestamps kept), its nested lines under it. */
  text: string;
  /** One short line for the node. */
  label: string;
  /** When it was written. */
  ms: number;
  /** How `ms` was found: a timestamp in it, the time typing began (born), a neighbour's, or a guess. */
  when: "stamp" | "born" | "near" | "guess";
  /** The daily note it's on (YYYY-MM-DD), or null for a page's own text. */
  day: string | null;
  /** The heading or label line it sits under ("" for none). */
  section: string;
  /** #tags and [[links]] in it, lower-case (the note's own name left out). */
  tags: string[];
  /** Line id of its first block, to jump to it in the note. */
  lid?: string;
  kind: "line" | "task" | "done" | "code" | "media";
  /** Position in the note (and across notes, in the order they were read). */
  order: number;
}

const isList = (t?: string) => !!t && /List$/.test(t);
const textOf = (b: JSONContent): string => (b.text ?? "") + (b.content ?? []).map(textOf).join(b.type === "doc" ? "\n" : "");
const STAMP = TIMESTAMP_RE.source;
const MEDIA: Record<string, string> = {
  attachmentImage: "🖼 Photo",
  attachmentMedia: "🎬 Clip",
  attachmentFile: "📎 File",
  youtubeEmbed: "▶ YouTube",
  linkCard: "🔗 Link",
  deadlineBar: "⏳ Deadline",
  mathBlock: "∑ Formula",
};

/** The first timestamp written in `text` (not a "✎ " edit stamp), as ms. */
export function stampIn(text: string): number | null {
  for (const m of text.matchAll(new RegExp(STAMP, "g"))) {
    if (text.slice(Math.max(0, m.index! - 2), m.index) === "✎ ") continue;
    const [, d, month, y, , hh, mm, ss] = m;
    return new Date(Number(y), MONTHS.indexOf(month), Number(d), Number(hh), Number(mm), Number(ss)).getTime();
  }
  return null;
}

function firstBorn(blocks: JSONContent[]): number | null {
  for (const b of blocks) {
    const born = b.attrs?.born;
    if (typeof born === "string") {
      const t = Date.parse(born);
      if (!Number.isNaN(t)) return t;
    }
    const inner = firstBorn(b.content ?? []);
    if (inner != null) return inner;
  }
  return null;
}

function firstLid(blocks: JSONContent[]): string | undefined {
  for (const b of blocks) {
    if (typeof b.attrs?.lid === "string") return b.attrs.lid;
    const inner = firstLid(b.content ?? []);
    if (inner) return inner;
  }
  return undefined;
}

/** A line with nothing but links, tags and timestamps left once those go ("[[Journal]]"), or a short "Ideas:" line. */
function labelOnly(text: string): boolean {
  const rest = text
    .replace(/!?\[\[[^\]]*\]\]/g, "")
    .replace(new RegExp(STAMP, "g"), "")
    .replace(/✎/g, "")
    .trim();
  return !rest || (rest.length <= 48 && /:$/.test(rest));
}

/** The node's one line: the first line, without timestamps, links shown as names. */
export function shortLabel(text: string): string {
  const first =
    text
      .split("\n")
      .map((l) => l.replace(/✎\s*/g, "").replace(new RegExp(STAMP, "g"), "").replace(/^[\s•☐☑✓-]+|\s+$/g, "").replace(/^\d+\.\s+/, ""))
      .find((l) => l.trim()) ?? "";
  return first.replace(/\s+/g, " ").trim();
}

function tagsIn(text: string, self?: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) out.add(m[1].trim().toLowerCase());
  for (const m of text.matchAll(/(^|[^\w#&])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) out.add(`#${m[2].toLowerCase()}`);
  if (self) out.delete(self.toLowerCase());
  return [...out];
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

interface Raw {
  blocks: JSONContent[];
  indent: number;
  section: string;
  kind: CanvasItem["kind"];
  /** A paragraph item can take deeper paragraphs under it. */
  open: boolean;
}

export interface ItemSource {
  /** The daily note's date, or null for a page's own text. */
  day: string | null;
  /** The note's own name ([[Journal]] lines under it aren't sections of their own). */
  self?: string;
  /** When nothing in the lines says when they were written. */
  fallbackMs: number;
  /** The first item's order number. */
  startOrder?: number;
}

/**
 * The lines of a note (or one day's entry for a page) as canvas items. Headings and label lines
 * ("[[Journal]]" above an indented list) become sections; each list item is its own item; deeper
 * paragraphs under a paragraph stay with it; a box (code block) is one item.
 */
export function itemsFromBlocks(blocks: JSONContent[], src: ItemSource): CanvasItem[] {
  const raws: Raw[] = [];
  let heading = "";
  let label: { text: string; indent: number } | null = null;
  const selfLower = src.self?.toLowerCase();
  const sectionName = (t: string) => {
    const s = shortLabel(plainLinks(t)).replace(/:$/, "").trim();
    return s.toLowerCase() === selfLower ? "" : s;
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const indent = Number(b.attrs?.indent ?? 0);
    if (label && indent <= label.indent) label = null;
    const section: string = (label as { text: string } | null)?.text || heading;
    const text = textOf(b).trim();
    if (b.type === "heading") {
      heading = sectionName(text);
      label = null;
      continue;
    }
    if (b.type === "horizontalRule") continue;
    if (isList(b.type)) {
      for (const item of b.content ?? []) {
        if (!textOf(item).trim()) continue;
        const kind = item.type === "taskItem" ? (item.attrs?.checked ? "done" : "task") : "line";
        raws.push({ blocks: [{ ...b, content: [item] }], indent, section, kind, open: false });
      }
      continue;
    }
    if (b.type === "paragraph") {
      if (!text) continue;
      const next = blocks[i + 1];
      if (labelOnly(text)) {
        if (next && Number(next.attrs?.indent ?? 0) > indent) {
          label = { text: sectionName(text) || section, indent };
          continue;
        }
        // A lone "[[Journal]]" with nothing under it says nothing by itself.
        if (!text.replace(/!?\[\[[^\]]*\]\]/g, "").replace(new RegExp(STAMP, "g"), "").trim()) continue;
      }
      const prev = raws[raws.length - 1];
      if (prev && prev.open && indent > prev.indent) {
        prev.blocks.push(b);
        continue;
      }
      raws.push({ blocks: [b], indent, section, kind: "line", open: true });
      continue;
    }
    if (b.type === "codeBlock" || b.type === "promptBlock") {
      if (text) raws.push({ blocks: [b], indent, section, kind: "code", open: false });
      continue;
    }
    if (text || MEDIA[b.type ?? ""]) raws.push({ blocks: [b], indent, section, kind: MEDIA[b.type ?? ""] && !text ? "media" : "line", open: false });
  }

  const order0 = src.startOrder ?? 0;
  const items: CanvasItem[] = raws.map((r, i) => {
    let text = plainText(r.blocks.map((b) => ({ ...b, attrs: { ...b.attrs, indent: Math.max(0, Number(b.attrs?.indent ?? 0) - r.indent) } })));
    if (!text.trim()) text = MEDIA[r.blocks[0].type ?? ""] ?? "";
    const stamp = stampIn(r.blocks.map(textOf).join("\n"));
    const born = stamp == null ? firstBorn(r.blocks) : null;
    const lid = firstLid(r.blocks);
    const label = shortLabel(text) || MEDIA[r.blocks[0].type ?? ""] || "…";
    return {
      key: lid ?? `${src.day ?? "page"}:${hash(text)}:${i}`,
      text,
      label,
      ms: stamp ?? born ?? NaN,
      when: stamp != null ? "stamp" : born != null ? "born" : "guess",
      day: src.day,
      section: r.section,
      tags: tagsIn(text, src.self),
      lid,
      kind: r.kind,
      order: order0 + i,
    };
  });
  // Lines with no time written come just after the line above them (or before the first that has one).
  let last: number | null = null;
  for (const it of items) {
    if (!Number.isNaN(it.ms)) last = it.ms;
    else if (last != null) (it.ms = last), (it.when = "near");
  }
  const firstKnown = items.find((it) => it.when !== "guess" && it.when !== "near");
  for (const it of items) if (Number.isNaN(it.ms)) (it.ms = firstKnown ? firstKnown.ms : src.fallbackMs), (it.when = firstKnown ? "near" : "guess");
  return items;
}

/** Noon of a YYYY-MM-DD day, local time. */
export const noonOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
};

/** Oldest first; lines written at the same moment keep the note's order. */
export const byTime = (a: CanvasItem, b: CanvasItem) => a.ms - b.ms || a.order - b.order;

// ───────────── Branches ─────────────

export type GroupMode = "topics" | "keywords" | "sections" | "tags";
export const OTHER = "Other";
export const UNSORTED = "New since sorting";

const STOP = new Set(
  `about above after again against also always among another anything around because been before being below between both but cannot can't could didn't does doesn't doing done down during each else even every from further getting give going gonna have having here hers herself himself into isn't it's itself just keep know like look looks made make making many maybe more most much must myself need needs never next nothing once only other others ours ourselves over own please pretty probably put quite rather really right same see seems shall she should shoud shouldn't show since some something somthing still such sure take than that that's their theirs them themselves then there these they thing things think this those though through thus till too under until upon very want wanted wants wnat well were what when where which while will with within without would wouldn't yeah yes you your yours yourself also able abel just like want wnat thing things work works working when then than this that with have from into they them their there what which also really little bit lot lots stuff way ways time today now new one two three first last every can't won't don't i'm i've i'll it's that's what's there's let's add added adding use used using app also`.split(
    /\s+/,
  ),
);

const stem = (w: string) => w.replace(/'s$/, "").replace(/(?<=\w{3})(ies)$/, "y").replace(/(?<=\w{4})s$/, (s, i, all) => (all[i - 1] === "s" ? s : ""));

function words(text: string): string[] {
  const clean = text
    .toLowerCase()
    .replace(new RegExp(STAMP, "gi"), " ")
    .replace(/https?:\S+/g, " ")
    .replace(/attachments\/\S+/g, " ");
  return clean.match(/\p{L}[\p{L}\p{N}'’-]{2,}/gu) ?? [];
}

/**
 * Branches without AI: the words that tie lines together. Greedy: the word shared by the most
 * lines not yet placed becomes a branch, until no word is shared by two. Lines left over → Other.
 */
export function keywordGroups(items: { key: string; text: string }[], self?: string, max = 10): Map<string, string> {
  const selfWords = new Set(words(self ?? "").map(stem));
  const perItem = items.map((it) => {
    const set = new Set<string>();
    for (const w of words(it.text)) {
      const s = stem(w.replace(/[’']/g, "'"));
      if (s.length < 4 || STOP.has(w) || STOP.has(s) || selfWords.has(s)) continue;
      set.add(s);
    }
    return set;
  });
  const surface = new Map<string, Map<string, number>>();
  items.forEach((it) => {
    for (const w of words(it.text)) {
      const s = stem(w);
      const m = surface.get(s) ?? new Map<string, number>();
      m.set(w, (m.get(w) ?? 0) + 1);
      surface.set(s, m);
    }
  });
  const df = new Map<string, number>();
  perItem.forEach((set) => set.forEach((s) => df.set(s, (df.get(s) ?? 0) + 1)));
  const tooCommon = Math.max(3, Math.ceil(items.length * 0.5));
  const out = new Map<string, string>();
  const left = new Set(items.map((_, i) => i));
  for (let g = 0; g < max && left.size; g++) {
    let best = "";
    let bestN = 1;
    for (const [s, n] of df) {
      if (n > tooCommon) continue;
      let c = 0;
      for (const i of left) if (perItem[i].has(s)) c++;
      if (c > bestN || (c === bestN && c > 1 && n > (df.get(best) ?? 0))) (best = s), (bestN = c);
    }
    if (!best) break;
    const forms = [...(surface.get(best) ?? new Map([[best, 1]]))].sort((a, b) => b[1] - a[1]);
    const name = forms[0][0].charAt(0).toUpperCase() + forms[0][0].slice(1);
    for (const i of [...left]) if (perItem[i].has(best)) (out.set(items[i].key, name), left.delete(i));
    df.delete(best);
  }
  for (const i of left) out.set(items[i].key, OTHER);
  return out;
}

/** Each item's branch for a grouping mode. `topics` are the saved AI topics (item key → name). */
export function branchOf(items: CanvasItem[], mode: GroupMode, self?: string, topics?: Record<string, string>): Map<string, string> {
  if (mode === "topics" && topics) return new Map(items.map((it) => [it.key, topics[it.key] || UNSORTED]));
  if (mode === "sections") return new Map(items.map((it) => [it.key, it.section || (it.day ? "Notes" : "Page")]));
  if (mode === "tags")
    return new Map(items.map((it) => [it.key, it.tags[0] ? (it.tags[0].startsWith("#") ? it.tags[0] : `[[${it.tags[0]}]]`) : "No tag or link"]));
  return keywordGroups(items, self);
}

// ───────────── Layout ─────────────

export const NODE_W = 184;
export const NODE_H = 32;
const VGAP = 8;
const STACK = 4;
const ROW_GAP = 26;
const COL_PAD = 10;
const SUB_GAP = 12;
const EMPTY_W = 34;
export const ROOT_W = 156;
export const PILL_W = 150;
const PILL_X = ROOT_W + 70;
const COLS_X = PILL_X + PILL_W + 60;
const TOP = 64;

export interface PlacedItem extends CanvasItem {
  branch: string;
  x: number;
  y: number;
  /** Column bucket ("2026-11-12" or "2026-11-12 14"). */
  bucket: string;
  /** Index on its branch, oldest first. */
  k: number;
}
export interface Column {
  bucket: string;
  x: number;
  w: number;
  label: string;
  sub: string;
  count: number;
  /** A gap of empty days folded into one narrow column. */
  gap?: boolean;
}
export interface Branch {
  name: string;
  y: number;
  h: number;
  items: PlacedItem[];
  /** Born at its first item's time. */
  ms: number;
  hue: number;
}
export interface Cell {
  branch: string;
  bucket: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ms: number;
}
export interface CanvasLayout {
  unit: "day" | "hour";
  items: PlacedItem[];
  columns: Column[];
  branches: Branch[];
  cells: Cell[];
  width: number;
  height: number;
  root: { x: number; y: number };
  pillX: number;
}

const DAY_MS = 86_400_000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MS3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A pleasant spread of hues for branches, the same name always the same hue. */
export const branchHue = (name: string, i: number) => (name === OTHER || name === UNSORTED ? -1 : (i * 137.5 + 18) % 360);

/** Places the items: columns by day (or hour, when it all happened on one day), a row per branch. */
export function layoutCanvas(input: CanvasItem[], branchFor: Map<string, string>): CanvasLayout {
  const items = [...input].sort(byTime);
  const first = items[0]?.ms ?? Date.now();
  const last = items[items.length - 1]?.ms ?? first;
  const unit: "day" | "hour" = last - first <= 30 * 3_600_000 && dayKey(new Date(first)) === dayKey(new Date(last)) ? "hour" : "day";
  const bucketOf = (ms: number) => {
    const d = new Date(ms);
    return unit === "day" ? dayKey(d) : `${dayKey(d)} ${pad(d.getHours())}`;
  };

  // Every bucket from the first to the last; long runs of empty days fold into one gap.
  const buckets: { bucket: string; gap?: boolean; ms: number }[] = [];
  if (items.length) {
    if (unit === "hour") {
      const d = new Date(first);
      for (let h = d.getHours(); h <= new Date(last).getHours(); h++) {
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
        buckets.push({ bucket: bucketOf(at), ms: at });
      }
    } else {
      const used = new Set(items.map((it) => bucketOf(it.ms)));
      const start = new Date(first);
      let t = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12).getTime();
      let empty: number[] = [];
      const flush = () => {
        if (empty.length > 3) buckets.push({ bucket: `gap:${dayKey(new Date(empty[0]))}`, gap: true, ms: empty[0] });
        else empty.forEach((e) => buckets.push({ bucket: bucketOf(e), ms: e }));
        empty = [];
      };
      for (; t <= last + DAY_MS / 2; t = new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate() + 1, 12).getTime()) {
        if (used.has(bucketOf(t))) (flush(), buckets.push({ bucket: bucketOf(t), ms: t }));
        else empty.push(t);
      }
      flush();
    }
  }

  // Branches in the order they were born; Other and New-since-sorting last.
  const byBranch = new Map<string, CanvasItem[]>();
  for (const it of items) {
    const b = branchFor.get(it.key) ?? OTHER;
    (byBranch.get(b) ?? byBranch.set(b, []).get(b)!).push(it);
  }
  const tail = (n: string) => (n === UNSORTED ? 2 : n === OTHER ? 1 : 0);
  const names = [...byBranch.keys()].sort((a, b) => tail(a) - tail(b) || byBranch.get(a)![0].ms - byBranch.get(b)![0].ms);

  const cellItems = new Map<string, CanvasItem[]>();
  for (const n of names) for (const it of byBranch.get(n)!) {
    const key = `${n}\u0000${bucketOf(it.ms)}`;
    (cellItems.get(key) ?? cellItems.set(key, []).get(key)!).push(it);
  }
  const subcols = new Map<string, number>();
  for (const [key, list] of cellItems) {
    const b = key.split("\u0000")[1];
    subcols.set(b, Math.max(subcols.get(b) ?? 0, Math.ceil(list.length / STACK)));
  }

  const columns: Column[] = [];
  let x = COLS_X;
  const colAt = new Map<string, Column>();
  for (const b of buckets) {
    const n = subcols.get(b.bucket) ?? 0;
    const w = n ? n * (NODE_W + SUB_GAP) - SUB_GAP + COL_PAD * 2 : b.gap ? 46 : EMPTY_W;
    const d = new Date(b.ms);
    const count = items.filter((it) => bucketOf(it.ms) === b.bucket).length;
    const col: Column = {
      bucket: b.bucket,
      x,
      w,
      count,
      gap: b.gap,
      label: b.gap ? "⋯" : unit === "day" ? `${d.getDate()} ${MS3[d.getMonth()]} · ${WD[d.getDay()]}` : `${pad(d.getHours())}:00`,
      sub: b.gap ? "quiet days" : count ? `${count} line${count > 1 ? "s" : ""}` : "",
    };
    columns.push(col);
    colAt.set(b.bucket, col);
    x += w;
  }
  const width = x + 60;

  const branches: Branch[] = [];
  const placed: PlacedItem[] = [];
  const cells: Cell[] = [];
  let y = TOP;
  names.forEach((name, bi) => {
    const list = byBranch.get(name)!;
    let rows = 1;
    for (const b of buckets) rows = Math.max(rows, Math.min(STACK, cellItems.get(`${name}\u0000${b.bucket}`)?.length ?? 0));
    const h = rows * (NODE_H + VGAP) - VGAP;
    const br: Branch = { name, y, h, items: [], ms: list[0].ms, hue: branchHue(name, bi) };
    for (const b of buckets) {
      const cell = cellItems.get(`${name}\u0000${b.bucket}`);
      if (!cell) continue;
      const col = colAt.get(b.bucket)!;
      cell.forEach((it, k) => {
        const sc = Math.floor(k / STACK);
        const r = k % STACK;
        const p: PlacedItem = { ...it, branch: name, bucket: b.bucket, x: col.x + COL_PAD + sc * (NODE_W + SUB_GAP), y: y + r * (NODE_H + VGAP), k: 0 };
        placed.push(p);
        br.items.push(p);
      });
      const xs = br.items.filter((p) => p.bucket === b.bucket);
      const maxX = Math.max(...xs.map((p) => p.x));
      const maxY = Math.max(...xs.map((p) => p.y));
      cells.push({ branch: name, bucket: b.bucket, x: col.x + COL_PAD - 6, y: y - 6, w: maxX - (col.x + COL_PAD) + NODE_W + 12, h: maxY - y + NODE_H + 12, ms: cell[0].ms });
    }
    br.items.sort(byTime).forEach((p, k) => (p.k = k));
    branches.push(br);
    y += h + ROW_GAP;
  });
  const height = Math.max(y + 24, TOP + 120);
  const rootY = branches.length ? (branches[0].y + branches[branches.length - 1].y + branches[branches.length - 1].h) / 2 : TOP + 40;
  return { unit, items: placed.sort(byTime), columns, branches, cells, width, height, root: { x: 24, y: rootY }, pillX: PILL_X };
}

/** The moments to step through: each distinct time something was written, oldest first. */
export const momentsOf = (items: { ms: number }[]) => [...new Set(items.map((i) => i.ms))].sort((a, b) => a - b);

/** "12 Nov, 14:05": short time for a node or a list. */
export function shortWhen(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MS3[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Ticks for the slider: up to `n` evenly spread labelled days. */
export function sliderTicks(from: number, to: number, unit: "day" | "hour", n = 6): { at: number; label: string }[] {
  if (to <= from) return [{ at: 0, label: shortWhen(from) }];
  const out: { at: number; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = from + ((to - from) * i) / (n - 1);
    const d = new Date(t);
    out.push({ at: i / (n - 1), label: unit === "hour" ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getDate()} ${MS3[d.getMonth()]}` });
  }
  return out;
}

/** Text for the AI (or reading aloud): the items, oldest first, each with when it was written. */
export function itemsText(items: CanvasItem[], max = 12_000): string {
  const parts: string[] = [];
  let len = 0;
  for (const it of [...items].sort(byTime)) {
    const line = `[${shortWhen(it.ms)}] ${it.text.replace(/\n{2,}/g, "\n").trim()}`;
    if (len + line.length > max) {
      parts.push(`… and ${items.length - parts.length} more lines`);
      break;
    }
    parts.push(line);
    len += line.length + 2;
  }
  return parts.join("\n\n");
}

/** A short fingerprint of some text, to know if a saved summary is still about the same words. */
export const fingerprint = hash;

/** When a day's entry began: a timestamp in it, else when typing in it began, else that day's noon. */
export function entryStart(blocks: JSONContent[], day: string): number {
  return stampIn(blocks.map(textOf).join("\n")) ?? firstBorn(blocks) ?? noonOf(day);
}
