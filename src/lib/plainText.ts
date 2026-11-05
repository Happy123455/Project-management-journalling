import type { JSONContent } from "@tiptap/react";
import { WIKILINK_RE } from "./links";
import { splitTarget } from "./noteLinks";

/**
 * Notes as plain text for copying: what's written, without the app's markup. [[Links]] become
 * their names (or aliases), lists keep a "•" / "1." / "☐" in front, nesting is two spaces, empty
 * lines between blocks stay single, and nothing like <br/> or %%…%% comes along.
 */

/** "[[Ravi|my friend]]" → "my friend", "[[2026-11-03#Plans]]" → "2026-11-03 › Plans". */
export function plainLinks(text: string): string {
  return text.replace(/!?\[\[[^\]]*\]\]/g, (m) => {
    const inner = [...m.matchAll(WIKILINK_RE)][0];
    if (!inner) return m;
    const alias = /\|([^\]]*)\]\]$/.exec(m)?.[1]?.trim();
    if (alias) return alias;
    const { note, section } = splitTarget(inner[1]);
    // "[[ ]]" (no name in it) is text the person wrote: kept as it is.
    if (!note) return m;
    return section ? `${note} › ${section}` : note;
  });
}

function inlineText(nodes: JSONContent[] | undefined): string {
  let out = "";
  for (const n of nodes ?? []) {
    if (n.type === "text") out += n.text ?? "";
    else if (n.type === "hardBreak") out += "\n";
    else if (n.type === "attachmentImage" || n.type === "attachmentMedia") out += n.attrs?.name ? `[${n.attrs.name}]` : "";
    else if (n.content) out += inlineText(n.content);
  }
  return plainLinks(out);
}

function blockLines(b: JSONContent, depth: number, out: string[], marker = "") {
  const pad = "  ".repeat(depth);
  switch (b.type) {
    case "paragraph":
    case "heading":
      out.push(...inlineText(b.content).split("\n").map((l, i) => (i ? pad + " ".repeat(marker.length) : pad + marker) + l));
      return;
    case "codeBlock":
      out.push(...(b.content ?? []).map((t) => t.text ?? "").join("").split("\n").map((l) => pad + l));
      return;
    case "bulletList":
    case "orderedList":
    case "taskList": {
      let n = Number(b.attrs?.start ?? 1);
      for (const item of b.content ?? []) {
        const mark = b.type === "bulletList" ? "• " : b.type === "orderedList" ? `${n++}. ` : item.attrs?.checked ? "☑ " : "☐ ";
        listItem(item, depth, out, mark);
      }
      return;
    }
    case "blockquote":
      for (const c of b.content ?? []) blockLines(c, depth, out, "> ");
      return;
    case "horizontalRule":
      out.push(pad + "———");
      return;
    case "linkCard":
      if (b.attrs?.url) out.push(pad + String(b.attrs.url));
      return;
    case "youtubeEmbed":
      if (b.attrs?.url) out.push(pad + String(b.attrs.url));
      return;
    case "attachmentFile":
      if (b.attrs?.name) out.push(`${pad}[${b.attrs.name}]`);
      return;
    case "mathBlock":
      if (b.attrs?.latex) out.push(pad + String(b.attrs.latex));
      return;
    default:
      for (const c of b.content ?? []) blockLines(c, depth, out, marker);
  }
}

function listItem(item: JSONContent, depth: number, out: string[], mark: string) {
  let first = true;
  for (const c of item.content ?? []) {
    if (/List$/.test(c.type ?? "")) blockLines(c, depth + 1, out);
    else {
      blockLines(c, depth, out, first ? mark : " ".repeat(mark.length));
      first = false;
    }
  }
}

export interface PlainOptions {
  /** Leave out a box's title line when it's only the [[link]] (and a timestamp). */
  dropBoxTitle?: boolean;
}

/** "[[Project]]" or "27,October,2026 Tuesday (22:04:26) [[Project]]": only a box's name. */
function onlyBoxName(b: JSONContent): boolean {
  if (b.type !== "paragraph" && b.type !== "heading") return false;
  const raw = (b.content ?? []).map((n) => n.text ?? "").join("");
  const rest = raw.replace(/!?\[\[[^\]]*\]\]/g, "").replace(/\d{1,2},[A-Za-z]+,\d{4} [A-Za-z]+ \(\d{2}:\d{2}:\d{2}\)/g, "").trim();
  return /\[\[[^\]]+\]\]/.test(raw) && !rest;
}

/** Blocks → plain text. */
export function plainText(blocks: JSONContent[], opts: PlainOptions = {}): string {
  const out: string[] = [];
  // The box's own title line goes; what was nested under it moves out one step.
  const drop = !!opts.dropBoxTitle && !!blocks[0] && onlyBoxName(blocks[0]);
  const base = drop ? Number(blocks[0].attrs?.indent ?? 0) + 1 : 0;
  blocks.forEach((b, i) => {
    if (drop && i === 0) return;
    blockLines(b, Math.max(0, Number(b.attrs?.indent ?? 0) - base), out);
  });
  // Trailing spaces off, one empty line at most in a row, none at the ends.
  const lines = out.map((l) => l.replace(/\s+$/, ""));
  const kept: string[] = [];
  for (const l of lines) if (l || (kept.length && kept[kept.length - 1])) kept.push(l);
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return kept.join("\n");
}
