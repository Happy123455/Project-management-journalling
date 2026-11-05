import type { JSONContent } from "@tiptap/react";

/**
 * Source mode: a note as plain characters (Markdown, the way Obsidian writes it) and back.
 *
 *   # Heading            - bullet         1. numbered       - [ ] task / - [x] done
 *   > quote              ```lang … ```    ---  (divider)    a tab per nesting level
 *   **bold** *italic* ~~strike~~ ==highlight== `code` <u>underline</u> [text](https://link)
 *   ![[attachments/<id>/<name>|align=free w=35% x=10% y=4%]]   a photo, GIF, clip, voice note or PDF
 *   ![align=center](https://youtu.be/…)                          a YouTube player
 *   🔗 https://…                                                 a link preview card
 *   %%{"info":{…}}%%   at the end of a line: what the block carries that has no Markdown (block
 *                      info, folded state); %%list{…}%% on its own line does the same for a list.
 *
 * One line is one paragraph (an empty line is an empty paragraph), as in the editor. Anything
 * Markdown can't hold (a prompt block, a code block inside a list…) is kept as a ```block fence
 * holding its JSON, so going to Source mode and back never loses anything.
 */

type Attrs = Record<string, unknown>;

/** Attrs that mean nothing set: they are left out. */
const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === false || v === 0 || v === "" || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/**
 * Bookkeeping attrs the app keeps for itself (`born`: when typing in a line began). They are not
 * written into Source mode; reading back puts them back from the note as it was (SourceMemory).
 */
const HIDDEN = ["born"];

function extras(attrs: Attrs | undefined, handled: string[]): Attrs | null {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (!handled.includes(k) && !HIDDEN.includes(k) && !isEmpty(v)) out[k] = v;
  return Object.keys(out).length ? out : null;
}
const suffix = (x: Attrs | null) => (x ? ` %%${JSON.stringify(x)}%%` : "");

// ───────────── Writing ─────────────

const MARK_ORDER = ["link", "bold", "italic", "strike", "highlight", "underline", "code"];
const DELIM: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
  highlight: ["==", "=="],
  underline: ["<u>", "</u>"],
};

/** Escapes what would otherwise be read back as formatting. */
export function escapeText(s: string): string {
  return s
    // A "\" is doubled only where it would otherwise escape what comes next (or at the end, where
    // the next node's text follows), so "\n" or "C:\Users" read the same in Source mode.
    .replace(/\\(?=[*`~=[\]!<\\(]|$)/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/~~/g, "\\~\\~")
    .replace(/==/g, "\\=\\=")
    .replace(/<(\/?u>|br>)/g, "\\<$1")
    .replace(/!\[/g, "\\![")
    .replace(/\]\(/g, "]\\(");
}

const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;
function placementOpts(a: Attrs): string {
  const rel = a.units === "note";
  const len = (v: unknown) => (rel ? pct(Number(v)) : `${v}px`);
  const opts: string[] = [];
  if (a.align && a.align !== "inline") opts.push(`align=${a.align}`);
  if (a.width) opts.push(`w=${len(a.width)}`);
  if (a.x) opts.push(`x=${len(a.x)}`);
  if (a.y) opts.push(`y=${len(a.y)}`);
  return opts.join(" ");
}

function inlineText(nodes: JSONContent[] | undefined): string {
  let out = "";
  for (const n of nodes ?? []) {
    if (n.type === "text") {
      const marks = [...(n.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
      const code = marks.some((m) => m.type === "code");
      let s = code ? "`" + (n.text ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`" : escapeText(n.text ?? "");
      for (const m of [...marks].reverse()) {
        if (m.type === "code") continue;
        if (m.type === "link") s = `[${s}](${String(m.attrs?.href ?? "").replace(/\)/g, "%29").replace(/ /g, "%20")})`;
        else if (DELIM[m.type]) s = DELIM[m.type][0] + s + DELIM[m.type][1];
      }
      out += s;
    } else if (n.type === "hardBreak") out += "<br>";
    else if (n.type === "attachmentImage" || n.type === "attachmentMedia") {
      const a = n.attrs ?? {};
      const opts = placementOpts(a);
      out += `![[attachments/${a.fileId}/${a.name || "file"}${opts ? `|${opts}` : ""}]]`;
    } else if (n.type === "youtubeEmbed") {
      out += `![${placementOpts(n.attrs ?? {})}](${n.attrs?.url ?? ""})`;
    } else {
      // An inline node this file doesn't know: kept whole.
      out += `![[json:${encodeURIComponent(JSON.stringify(n))}]]`;
    }
  }
  return out;
}

/** A paragraph's text whose start would read as Markdown gets a "\" in front. */
const LINE_START = /^(#{1,6} |[-+] |\d+[.)] |> |```|---$|🔗 |  |%%)/;
/** Starts like Markdown, or with "\"s in front of something that does. */
const needsGuard = (s: string): boolean => LINE_START.test(s) || (s.startsWith("\\") && needsGuard(s.slice(1)));
const guardStart = (s: string) => (needsGuard(s) ? "\\" + s : s);
/** The characters a "\" escapes when reading back; before anything else it is a plain "\". */
const ESCAPABLE = /[*`~=[\]!<\\(]/;

const tabs = (n: number) => "\t".repeat(Math.max(0, n));
const fence = (node: JSONContent, depth: number) => `${tabs(depth)}\`\`\`block\n${JSON.stringify(node)}\n${tabs(depth)}\`\`\``;

/** Only paragraphs and lists inside list items have a Markdown form. */
const plainItems = (list: JSONContent): boolean =>
  (list.content ?? []).every((item) =>
    (item.content ?? []).every((c) => c.type === "paragraph" || (/List$/.test(c.type ?? "") && plainItems(c))),
  );

function listLines(list: JSONContent, depth: number, lines: string[]) {
  let n = Number(list.attrs?.start ?? 1);
  for (const item of list.content ?? []) {
    const marker = list.type === "orderedList" ? `${n++}. ` : list.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}] ` : "- ";
    const x = suffix(extras(item.attrs, ["checked"]));
    let first = true;
    for (const c of item.content ?? []) {
      if (c.type === "paragraph") {
        const text = inlineText(c.content) + (first ? x : "") + suffix(extras(c.attrs, ["indent"]));
        lines.push(first ? `${tabs(depth)}${marker}${text}` : `${tabs(depth)}  ${text}`);
        first = false;
      } else {
        if (first) lines.push(`${tabs(depth)}${marker}${x}`);
        first = false;
        const sub = extras(c.attrs, ["indent", "start"]);
        if (sub) lines.push(`${tabs(depth + 1)}%%list${JSON.stringify(sub)}%%`);
        listLines(c, depth + 1, lines);
      }
    }
    if (first) lines.push(`${tabs(depth)}${marker}${x}`);
  }
}

function blockLines(b: JSONContent, lines: string[]) {
  const indent = Number(b.attrs?.indent ?? 0);
  switch (b.type) {
    case "paragraph":
      lines.push(tabs(indent) + guardStart(inlineText(b.content)) + suffix(extras(b.attrs, ["indent"])));
      return;
    case "heading":
      lines.push(`${tabs(indent)}${"#".repeat(Number(b.attrs?.level ?? 1))} ${inlineText(b.content)}${suffix(extras(b.attrs, ["indent", "level"]))}`);
      return;
    case "horizontalRule":
      lines.push(`${tabs(indent)}---${suffix(extras(b.attrs, ["indent"]))}`);
      return;
    case "codeBlock": {
      const text = (b.content ?? []).map((t) => t.text ?? "").join("");
      // A line of ``` inside the code would end the fence early: keep such a block as JSON.
      if (/^\t*```/m.test(text)) return void lines.push(fence(b, indent));
      lines.push(`${tabs(indent)}\`\`\`${b.attrs?.language ?? ""}${suffix(extras(b.attrs, ["indent", "language"]))}`);
      lines.push(...text.split("\n"));
      lines.push(`${tabs(indent)}\`\`\``);
      return;
    }
    case "blockquote": {
      if (!(b.content ?? []).every((c) => c.type === "paragraph" && !extras(c.attrs, ["indent"]))) return void lines.push(fence(b, indent));
      const x = suffix(extras(b.attrs, ["indent"]));
      (b.content ?? []).forEach((c, i) => lines.push(`${tabs(indent)}> ${inlineText(c.content)}${i === 0 ? x : ""}`));
      if (!b.content?.length) lines.push(`${tabs(indent)}> ${x}`);
      return;
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      if (!plainItems(b) || !b.content?.length) return void lines.push(fence(b, indent));
      const x = extras(b.attrs, ["indent", "start"]);
      if (x) lines.push(`${tabs(indent)}%%list${JSON.stringify(x)}%%`);
      listLines(b, indent, lines);
      return;
    }
    case "linkCard":
      lines.push(`${tabs(indent)}🔗 ${b.attrs?.url ?? ""}${suffix(extras(b.attrs, ["indent", "url", "title", "site", "image", "status"]))}`);
      return;
    default:
      lines.push(fence(b, indent));
  }
}

/** The note as plain characters. */
export function docToSource(doc: JSONContent | null | undefined): string {
  const lines: string[] = [];
  for (const b of doc?.content ?? []) blockLines(b, lines);
  return lines.join("\n");
}

/** The note as Markdown to copy out: Source mode without the app's own %%{…}%% notes. */
export function docToMarkdown(doc: JSONContent | null | undefined): string {
  return docToSource(doc)
    .split("\n")
    .filter((l) => !/^\s*%%list\{.*\}%%\s*$/.test(l))
    .map((l) => l.replace(/ ?%%\{.*\}%%$/, ""))
    .join("\n");
}

// ───────────── Reading back ─────────────

/** What the note had, so read-back media and cards keep what the text doesn't show (type, size…). */
export interface SourceMemory {
  files: Map<string, JSONContent>;
  cards: Map<string, Attrs>;
  /** Hidden attrs of text blocks, by "type:text" (a queue, for lines that read the same). */
  hidden?: Map<string, Attrs[]>;
}

const nodeText = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(nodeText).join("");
const hiddenKey = (n: JSONContent) => `${n.type}:${nodeText(n)}`;

/** Gives text blocks back the hidden attrs they had before Source mode (matched by their text). */
function restoreHidden(n: JSONContent, mem: SourceMemory): void {
  if (!mem.hidden?.size) return;
  if ((n.type === "paragraph" || n.type === "heading") && !HIDDEN.some((k) => n.attrs?.[k])) {
    const queue = mem.hidden.get(hiddenKey(n));
    const kept = queue?.shift();
    if (kept) n.attrs = { ...(n.attrs ?? {}), ...kept };
  }
  n.content?.forEach((c) => restoreHidden(c, mem));
}

export function sourceMemory(...docs: (JSONContent | null | undefined)[]): SourceMemory {
  const files = new Map<string, JSONContent>();
  const cards = new Map<string, Attrs>();
  const hidden = new Map<string, Attrs[]>();
  const walk = (n: JSONContent) => {
    if (n.type === "paragraph" || n.type === "heading") {
      const kept: Attrs = {};
      for (const k of HIDDEN) if (n.attrs?.[k]) kept[k] = n.attrs[k];
      if (Object.keys(kept).length) {
        const key = hiddenKey(n);
        hidden.set(key, [...(hidden.get(key) ?? []), kept]);
      }
    }
    if ((n.type === "attachmentImage" || n.type === "attachmentMedia" || n.type === "attachmentFile") && n.attrs?.fileId) files.set(String(n.attrs.fileId), n);
    if (n.type === "linkCard" && n.attrs?.url) cards.set(String(n.attrs.url), n.attrs);
    n.content?.forEach(walk);
  };
  docs.forEach((d) => d && walk(d));
  return { files, cards, hidden };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg|avif)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv|3gp)$/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|aac|opus|flac|weba)$/i;

function readOpts(s: string): Attrs {
  const a: Attrs = {};
  let rel = false;
  for (const part of s.trim().split(/\s+/).filter(Boolean)) {
    const legacy = /^\|?(\d+)$/.exec(part);
    if (legacy) {
      a.width = Number(legacy[1]);
      continue;
    }
    const m = /^(align|w|x|y)=(-?[\d.]+%|-?[\d.]+(?:px)?|\w+)$/.exec(part);
    if (!m) continue;
    if (m[1] === "align") {
      a.align = m[2];
      continue;
    }
    const isPct = m[2].endsWith("%");
    const v = parseFloat(m[2]);
    if (!Number.isFinite(v)) continue;
    if (isPct) rel = true;
    a[m[1] === "w" ? "width" : m[1]] = isPct ? Math.round(v * 100) / 10000 : v;
  }
  if (rel) a.units = "note";
  return a;
}

function mediaFromRef(ref: string, opts: string, mem: SourceMemory): JSONContent | null {
  const m = /^attachments\/([^/]+)\/(.+)$/.exec(ref.trim());
  if (!m) return null;
  const [, fileId, name] = m;
  const known = mem.files.get(fileId);
  const placed = readOpts(opts);
  const base = { width: null, align: "inline", x: 0, y: 0, units: null };
  if (known && known.type !== "attachmentFile") return { type: known.type, attrs: { ...known.attrs, ...base, ...placed, fileId, name } };
  if (IMAGE_EXT.test(name)) return { type: "attachmentImage", attrs: { ...base, ...placed, fileId, name } };
  const kind = VIDEO_EXT.test(name) ? "video" : AUDIO_EXT.test(name) ? "audio" : /\.pdf$/i.test(name) ? "pdf" : null;
  if (kind) return { type: "attachmentMedia", attrs: { ...base, ...placed, fileId, name, kind } };
  return null;
}

/** Inline Markdown back to text nodes (with marks), breaks and media. */
export function parseInline(src: string, mem: SourceMemory): JSONContent[] {
  // 1. Tokens.
  type Tok = { t: "text"; s: string } | { t: "delim"; d: string } | { t: "node"; n: JSONContent } | { t: "code"; s: string } | { t: "link"; inner: string; href: string };
  const toks: Tok[] = [];
  let buf = "";
  const flush = () => {
    if (buf) toks.push({ t: "text", s: buf });
    buf = "";
  };
  for (let i = 0; i < src.length; ) {
    const rest = src.slice(i);
    if (src[i] === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^!\[\[json:([^\]]*)\]\]/.exec(rest))) {
      try {
        flush();
        toks.push({ t: "node", n: JSON.parse(decodeURIComponent(m[1])) });
        i += m[0].length;
        continue;
      } catch {
        // not ours: plain text
      }
    }
    if ((m = /^!\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]*))?\]\]/.exec(rest))) {
      const node = mediaFromRef(m[1], m[2] ?? "", mem);
      if (node) {
        flush();
        toks.push({ t: "node", n: node });
        i += m[0].length;
        continue;
      }
    }
    if ((m = /^!\[([^\[\]\n]*)\]\((https?:\/\/[^)\s]+)\)/.exec(rest))) {
      flush();
      toks.push({ t: "node", n: { type: "youtubeEmbed", attrs: { width: null, align: "inline", x: 0, y: 0, units: null, ...readOpts(m[1]), url: m[2] } } });
      i += m[0].length;
      continue;
    }
    if (rest.startsWith("<br>")) {
      flush();
      toks.push({ t: "node", n: { type: "hardBreak" } });
      i += 4;
      continue;
    }
    if (src[i] === "`") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (j < src.length) {
        flush();
        toks.push({ t: "code", s });
        i = j + 1;
        continue;
      }
    }
    // [text](url), not a [[wikilink]].
    if (src[i] === "[" && src[i + 1] !== "[" && src[i - 1] !== "[") {
      const close = findLinkEnd(src, i);
      if (close) {
        flush();
        toks.push({ t: "link", inner: src.slice(i + 1, close.textEnd), href: close.href });
        i = close.end;
        continue;
      }
    }
    const d = ["**", "~~", "==", "<u>", "</u>", "*"].find((x) => rest.startsWith(x));
    if (d) {
      flush();
      toks.push({ t: "delim", d: d === "</u>" ? "<u>" : d });
      i += d.length;
      continue;
    }
    buf += src[i++];
  }
  flush();

  // 2. A delimiter without its partner is plain text (the last odd one of its kind).
  const count = new Map<string, number>();
  for (const t of toks) if (t.t === "delim") count.set(t.d, (count.get(t.d) ?? 0) + 1);
  const seen = new Map<string, number>();
  const NAME: Record<string, string> = { "**": "bold", "*": "italic", "~~": "strike", "==": "highlight", "<u>": "underline" };
  const active = new Set<string>();
  const out: JSONContent[] = [];
  const push = (n: JSONContent, extra: string[] = []) => {
    const marks = [...active, ...extra].map((type) => ({ type }));
    if (n.type === "text" && marks.length) n = { ...n, marks: [...(n.marks ?? []), ...marks] };
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) last.text += n.text ?? "";
    else out.push(n);
  };
  for (const t of toks) {
    if (t.t === "text") push({ type: "text", text: t.s });
    else if (t.t === "code") push({ type: "text", text: t.s }, ["code"]);
    else if (t.t === "node") out.push(t.n);
    else if (t.t === "link") {
      for (const n of parseInline(t.inner, mem)) {
        if (n.type !== "text") {
          out.push(n);
          continue;
        }
        push({ ...n, marks: [{ type: "link", attrs: { href: decodeLinkHref(t.href) } }, ...(n.marks ?? [])] });
      }
    } else {
      const k = (seen.get(t.d) ?? 0) + 1;
      seen.set(t.d, k);
      if (k === count.get(t.d) && k % 2 === 1) {
        push({ type: "text", text: t.d });
        continue;
      }
      const name = NAME[t.d];
      if (active.has(name)) active.delete(name);
      else active.add(name);
    }
  }
  return out.filter((n) => n.type !== "text" || n.text);
}

const decodeLinkHref = (h: string) => h.replace(/%29/g, ")").replace(/%20/g, " ");

function findLinkEnd(src: string, open: number): { textEnd: number; href: string; end: number } | null {
  let depth = 0;
  for (let j = open + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\" && ESCAPABLE.test(src[j + 1] ?? "")) {
      j++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const m = /^\]\(([^)\s]+)\)/.exec(src.slice(j));
      return m ? { textEnd: j, href: m[1], end: j + m[0].length } : null;
    }
  }
  return null;
}

/** A trailing %%{…}%% on a line: the attrs it holds, and the line without it. */
function takeSuffix(line: string): { line: string; attrs: Attrs | null } {
  const m = / ?%%(\{.*\})%%$/.exec(line);
  if (!m) return { line, attrs: null };
  try {
    const attrs = JSON.parse(m[1]);
    return attrs && typeof attrs === "object" ? { line: line.slice(0, m.index), attrs } : { line, attrs: null };
  } catch {
    return { line, attrs: null };
  }
}

const LIST_ITEM = /^(\t*)(?:(- \[( |x|X)\] )|(- |\+ )|((\d+)[.)] ))(.*)$/;

/** Plain characters back to a note. */
export function sourceToDoc(source: string, mem: SourceMemory = sourceMemory()): JSONContent {
  const lines = source.split("\n");
  const content: JSONContent[] = [];
  let pendingList: Attrs | null = null;
  const para = (text: string, attrs: Attrs = {}): JSONContent => {
    const inline = parseInline(text, mem);
    return { type: "paragraph", attrs, ...(inline.length ? { content: inline } : {}) };
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indent = /^\t*/.exec(raw)![0].length;
    const body = raw.slice(indent);

    // A block kept as JSON, or a code block.
    const f = /^```(.*)$/.exec(body);
    if (f) {
      const close = lines.findIndex((l, j) => j > i && l === `${"\t".repeat(indent)}\`\`\``);
      if (close > i) {
        const inner = lines.slice(i + 1, close);
        if (f[1] === "block") {
          try {
            content.push(JSON.parse(inner.join("\n")));
            i = close;
            continue;
          } catch {
            // Not valid any more: keep the text as a code block below.
          }
        }
        const { line: lang, attrs } = takeSuffix(f[1] === "block" ? "" : f[1]);
        const text = inner.join("\n");
        content.push({ type: "codeBlock", attrs: { ...(attrs ?? {}), indent, language: lang.trim() || null }, ...(text ? { content: [{ type: "text", text }] } : {}) });
        i = close;
        continue;
      }
    }

    const listMeta = /^%%list(\{.*\})%%$/.exec(body);
    if (listMeta) {
      try {
        pendingList = JSON.parse(listMeta[1]);
        continue;
      } catch {
        // plain text
      }
    }

    if (LIST_ITEM.test(raw)) {
      const { node, next } = readList(lines, i, indent, mem, pendingList);
      pendingList = null;
      content.push({ ...node, attrs: { ...(node.attrs ?? {}), indent } });
      i = next - 1;
      continue;
    }
    pendingList = null;

    const { line, attrs } = takeSuffix(body);
    const extra = attrs ?? {};
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
      const inline = parseInline(m[2], mem);
      content.push({ type: "heading", attrs: { ...extra, indent, level: m[1].length }, ...(inline.length ? { content: inline } : {}) });
    } else if (line === "---") content.push({ type: "horizontalRule", attrs: { ...extra, indent } });
    else if (/^> ?/.test(line)) {
      const paras: JSONContent[] = [para(line.replace(/^> ?/, ""))];
      while (i + 1 < lines.length && lines[i + 1].startsWith(`${"\t".repeat(indent)}>`)) paras.push(para(lines[++i].slice(indent).replace(/^> ?/, "")));
      content.push({ type: "blockquote", attrs: { ...extra, indent }, content: paras });
    } else if ((m = /^🔗 (\S+)$/.exec(line))) {
      const url = m[1];
      content.push({ type: "linkCard", attrs: { ...(mem.cards.get(url) ?? {}), ...extra, indent, url } });
    } else {
      const text = line.startsWith("\\") && needsGuard(line.slice(1)) ? line.slice(1) : line;
      content.push(para(text, { ...extra, indent }));
    }
  }
  if (!content.length) content.push({ type: "paragraph", attrs: { indent: 0 } });
  const doc: JSONContent = { type: "doc", content };
  // A fresh copy of the queues, so reading the same text back twice gives the same result.
  if (mem.hidden?.size) restoreHidden(doc, { ...mem, hidden: new Map([...mem.hidden].map(([k, v]) => [k, [...v]])) });
  return doc;
}

function readList(lines: string[], start: number, depth: number, mem: SourceMemory, listAttrs: Attrs | null): { node: JSONContent; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const kind = first[2] ? "taskList" : first[5] ? "orderedList" : "bulletList";
  const items: JSONContent[] = [];
  let i = start;
  let pendingSub: Attrs | null = null;
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_ITEM.exec(line);
    const lead = /^\t*/.exec(line)![0].length;
    if (m && lead === depth) {
      const itemKind = m[2] ? "taskList" : m[5] ? "orderedList" : "bulletList";
      if (itemKind !== kind) break;
      const { line: text, attrs } = takeSuffix(m[7]);
      const inline = parseInline(text, mem);
      const item: JSONContent = {
        type: kind === "taskList" ? "taskItem" : "listItem",
        attrs: { ...(attrs ?? {}), ...(kind === "taskList" ? { checked: m[3] !== " " } : {}) },
        content: [{ type: "paragraph", attrs: { indent: 0 }, ...(inline.length ? { content: inline } : {}) }],
      };
      items.push(item);
      i++;
      continue;
    }
    if (lead === depth && line.slice(depth).startsWith("  ") && items.length) {
      // A second paragraph in the same item.
      const inline = parseInline(line.slice(depth + 2), mem);
      items[items.length - 1].content!.push({ type: "paragraph", attrs: { indent: 0 }, ...(inline.length ? { content: inline } : {}) });
      i++;
      continue;
    }
    if (lead === depth + 1 && items.length) {
      const meta = /^%%list(\{.*\})%%$/.exec(line.slice(lead));
      if (meta) {
        try {
          pendingSub = JSON.parse(meta[1]);
          i++;
          continue;
        } catch {
          // fall through
        }
      }
      if (LIST_ITEM.test(line)) {
        const sub = readList(lines, i, depth + 1, mem, pendingSub);
        pendingSub = null;
        items[items.length - 1].content!.push(sub.node);
        i = sub.next;
        continue;
      }
    }
    break;
  }
  const start1 = kind === "orderedList" ? Number(first[6]) : null;
  const attrs: Attrs = { ...(listAttrs ?? {}), ...(start1 && start1 !== 1 ? { start: start1 } : {}) };
  return { node: { type: kind, attrs, content: items }, next: i };
}

/** Words and characters, for the Source mode status line. */
export function sourceStats(source: string) {
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return { words, chars: source.length, lines: source.split("\n").length };
}
