import React, { type ReactNode } from "react";
import type { JSONContent } from "@tiptap/react";
import { useFileUrl, showPhoto, openFile } from "../editor/attachments";
import { AudioPill } from "../editor/MediaBits";
import { EDIT_MARK } from "../editor/timestampChip";
import { skyFor } from "../lib/sky";
import { TIMESTAMP_RE } from "../lib/timestamp";
import { TAG_RE, WIKILINK_RE } from "../lib/links";

/**
 * A note drawn read-only, the way it looks in the editor (headings, lists, tasks, quotes, code,
 * photos and clips where they sit, timestamps as chips, [[links]] as their titles) without an
 * editor behind it: light enough for long lists of entries, the table pop-up and Reading mode.
 */
export interface DocViewProps {
  content: JSONContent[] | JSONContent | null | undefined;
  onOpenLink?: (title: string) => void;
  onOpenTag?: (tag: string) => void;
  /** Small media (a list of entries) instead of the sizes set in the note. */
  compact?: boolean;
  className?: string;
}

export function DocView({ content, onOpenLink, onOpenTag, compact, className }: DocViewProps) {
  const blocks = Array.isArray(content) ? content : content?.type === "doc" ? content.content ?? [] : content ? [content] : [];
  const ctx: Ctx = { onOpenLink, onOpenTag, compact: !!compact };
  return <div className={`doc-view${compact ? " compact" : ""}${className ? ` ${className}` : ""}`}>{blocks.map((b, i) => renderBlock(b, i, ctx))}</div>;
}

interface Ctx {
  onOpenLink?: (title: string) => void;
  onOpenTag?: (tag: string) => void;
  compact: boolean;
}

const indentStyle = (b: JSONContent): React.CSSProperties | undefined => {
  const n = Number(b.attrs?.indent ?? 0);
  return n ? { marginLeft: `${n * 22}px` } : undefined;
};

function renderBlock(b: JSONContent, key: number, ctx: Ctx): ReactNode {
  const kids = () => (b.content ?? []).map((c, i) => renderBlock(c, i, ctx));
  const inline = () => renderInline(b.content ?? [], ctx);
  switch (b.type) {
    case "paragraph":
      return <p key={key} style={indentStyle(b)}>{b.content?.length ? inline() : <br />}</p>;
    case "heading": {
      const Tag = `h${Math.min(6, Math.max(1, Number(b.attrs?.level ?? 2)))}` as "h2";
      return <Tag key={key} style={indentStyle(b)}>{inline()}</Tag>;
    }
    case "bulletList":
      return <ul key={key} style={indentStyle(b)}>{kids()}</ul>;
    case "orderedList":
      return <ol key={key} start={b.attrs?.start ?? 1} style={indentStyle(b)}>{kids()}</ol>;
    case "taskList":
      return <ul key={key} className="doc-tasks" style={indentStyle(b)}>{kids()}</ul>;
    case "listItem":
      return <li key={key}>{kids()}</li>;
    case "taskItem":
      return (
        <li key={key} className={b.attrs?.checked ? "done" : ""}>
          <span className="doc-check" aria-hidden>{b.attrs?.checked ? "☑" : "☐"}</span>
          <div>{kids()}</div>
        </li>
      );
    case "blockquote":
      return <blockquote key={key} style={indentStyle(b)}>{kids()}</blockquote>;
    case "codeBlock":
      return (
        <pre key={key} className="doc-code" style={indentStyle(b)}>
          <code>{(b.content ?? []).map((t) => t.text ?? "").join("")}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr key={key} />;
    case "attachmentFile":
      return <FileChip key={key} attrs={b.attrs ?? {}} />;
    case "linkCard":
      return (
        <a key={key} className="doc-link-card" href={b.attrs?.url} target="_blank" rel="noreferrer" style={indentStyle(b)}>
          {b.attrs?.image && <img src={b.attrs.image} alt="" loading="lazy" />}
          <span>
            <strong>{b.attrs?.title || b.attrs?.url}</strong>
            <small>{b.attrs?.site || hostOf(b.attrs?.url)}</small>
          </span>
        </a>
      );
    case "promptBlock":
      return (
        <div key={key} className="doc-prompt" style={indentStyle(b)}>
          🧩 <strong>{b.attrs?.title || "Prompt"}</strong>
          {b.attrs?.template && <pre>{String(b.attrs.template)}</pre>}
        </div>
      );
    default:
      // A block from a newer version, or inline content at the top: show what it holds.
      if (b.content) return <div key={key}>{b.content.some((c) => c.type === "text") ? inline() : kids()}</div>;
      return renderInline([b], ctx);
  }
}

const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return url ?? "";
  }
};

function renderInline(nodes: JSONContent[], ctx: Ctx): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "text") return <React.Fragment key={i}>{withMarks(n, textPieces(n.text ?? "", ctx, !!n.marks?.some((m) => m.type === "code")))}</React.Fragment>;
    if (n.type === "hardBreak") return <br key={i} />;
    if (n.type === "attachmentImage" || n.type === "attachmentMedia") return <Media key={i} attrs={n.attrs ?? {}} image={n.type === "attachmentImage"} compact={ctx.compact} />;
    if (n.type === "youtubeEmbed") return <YoutubeThumb key={i} url={n.attrs?.url ?? ""} />;
    return n.content ? <React.Fragment key={i}>{renderInline(n.content, ctx)}</React.Fragment> : null;
  });
}

function withMarks(n: JSONContent, inner: ReactNode): ReactNode {
  let out = inner;
  for (const m of n.marks ?? []) {
    if (m.type === "bold") out = <strong>{out}</strong>;
    else if (m.type === "italic") out = <em>{out}</em>;
    else if (m.type === "strike") out = <s>{out}</s>;
    else if (m.type === "code") out = <code>{out}</code>;
    else if (m.type === "highlight") out = <mark>{out}</mark>;
    else if (m.type === "underline") out = <u>{out}</u>;
    else if (m.type === "link") out = <a href={m.attrs?.href} target="_blank" rel="noreferrer">{out}</a>;
  }
  return out;
}

/** Plain text with [[links]] shown as their titles, #tags and timestamps as chips. */
function textPieces(text: string, ctx: Ctx, raw: boolean): ReactNode {
  if (raw) return text;
  type Hit = { at: number; len: number; node: ReactNode };
  const hits: Hit[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    const alias = /\|([^\]]*)\]\]$/.exec(m[0])?.[1]?.trim();
    hits.push({
      at: m.index!,
      len: m[0].length,
      node: (
        <span
          className="wikilink"
          role="link"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onOpenLink?.(target);
          }}
        >
          {alias || target}
        </span>
      ),
    });
  }
  for (const m of text.matchAll(TIMESTAMP_RE)) {
    const [full, day, month, , , hour, minute] = m;
    const edit = text.slice(Math.max(0, m.index! - EDIT_MARK.length), m.index!) === EDIT_MARK;
    const sky = skyFor(Number(hour));
    const at = m.index! - (edit ? EDIT_MARK.length : 0);
    hits.push({
      at,
      len: full.length + (edit ? EDIT_MARK.length : 0),
      node: (
        <span className={`ts-chip ts-${sky.phase}${edit ? " ts-edit" : ""}`} title={full} style={{ "--sky": sky.bg, "--sky-fg": sky.fg } as React.CSSProperties}>
          {edit ? `✎ ${day} ${month.slice(0, 3)}, ${hour}:${minute}` : `${sky.icon} ${hour}:${minute}`}
        </span>
      ),
    });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const at = m.index! + m[1].length;
    hits.push({
      at,
      len: m[2].length + 1,
      node: (
        <span
          className="tag"
          role="link"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onOpenTag?.(m[2]);
          }}
        >
          #{m[2]}
        </span>
      ),
    });
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a.at - b.at);
  const out: ReactNode[] = [];
  let pos = 0;
  hits.forEach((h, i) => {
    if (h.at < pos) return; // overlaps one already shown (a tag inside a link)
    if (h.at > pos) out.push(text.slice(pos, h.at));
    out.push(<React.Fragment key={i}>{h.node}</React.Fragment>);
    pos = h.at + h.len;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/** A photo, GIF, clip, video, voice note or PDF where it sits in the text. */
function Media({ attrs, image, compact }: { attrs: Record<string, any>; image: boolean; compact: boolean }) {
  const name = String(attrs.name ?? "");
  const kind = image ? "image" : String(attrs.kind ?? "video");
  const loops = /^(gif|meme|greenscreen)-/.test(name);
  const { url, failed } = useFileUrl(kind === "pdf" ? null : attrs.fileId ?? null, kind === "video" || kind === "audio");
  const align = String(attrs.align ?? "inline");
  const width = attrs.width ? (attrs.units === "note" ? `${(attrs.width * 100).toFixed(2)}%` : `${attrs.width}px`) : undefined;
  const style: React.CSSProperties = compact ? {} : { width };
  const cls = `doc-media align-${align === "free" ? "center" : align}${compact ? " compact" : ""}`;
  if (kind === "pdf")
    return (
      <button type="button" className="doc-file" onClick={(e) => (e.stopPropagation(), void openFile(attrs.fileId))}>
        📕 {name}
      </button>
    );
  if (!url) return <span className={cls} style={style}><span className="attach-missing">{failed ? "Not found" : "…"}</span></span>;
  if (kind === "audio") return <span className={cls}><AudioPill src={url} icon={name.startsWith("sound-") ? "🔊" : "🎙"} /></span>;
  return (
    <span className={cls} style={style}>
      {kind === "image" ? (
        <img src={url} alt="" loading="lazy" onClick={(e) => (e.stopPropagation(), showPhoto(url))} />
      ) : loops ? (
        <video src={url} autoPlay loop muted playsInline />
      ) : (
        <video src={url} controls playsInline preload="metadata" onClick={(e) => e.stopPropagation()} />
      )}
    </span>
  );
}

function FileChip({ attrs }: { attrs: Record<string, any> }) {
  return (
    <button type="button" className="doc-file" onClick={(e) => (e.stopPropagation(), void openFile(attrs.fileId))}>
      📎 {attrs.name}
    </button>
  );
}

function YoutubeThumb({ url }: { url: string }) {
  const id = /(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(url)?.[1];
  return (
    <a className="doc-media doc-youtube" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {id ? <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" /> : "▶ YouTube"}
    </a>
  );
}
