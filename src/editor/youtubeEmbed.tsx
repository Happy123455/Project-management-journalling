import { mergeAttributes, Node, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { youtubeId } from "../lib/linkPreview";
import { mediaNodeViewOptions, PlacedMedia, placementAttributes, selectMedia } from "./attachments";

/** Obsidian's external embed: ![](https://youtu.be/…), optionally with a width: ![|400](…). */
export const YT_EMBED_RE = /!\[[^\]|\n]*(?:\|(\d+))?\]\((https?:\/\/[^\s)]+)\)/;

/** The embed for a lone `![](youtube link)`, or null. */
export function youtubeEmbedFrom(text: string): { url: string; width: number | null } | null {
  const m = new RegExp(`^${YT_EMBED_RE.source}$`).exec(text.trim());
  return m && youtubeId(m[2]) ? { url: m[2], width: m[1] ? Number(m[1]) : null } : null;
}

const TYPED_RE = /!\[[^\]|\n]*(?:\|(\d+))?\]\((https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/[^\s)]+)\)/;

function startSeconds(url: string): number {
  try {
    const t = new URL(url).searchParams.get("t") ?? "";
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  } catch {
    return 0;
  }
}

function YoutubeView(props: NodeViewProps) {
  const { url } = props.node.attrs as { url: string };
  const id = youtubeId(url);
  const start = startSeconds(url);
  return (
    <PlacedMedia {...props}>
      {/* The rim around the player is its hit box: tap it (or the grip) to select, resize and place. */}
      <span
        className="yt-embed"
        contentEditable={false}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          selectMedia(props);
        }}
      >
        <button
          type="button"
          className="media-grip"
          aria-label="Select video"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            selectMedia(props);
          }}
        >
          ⤢
        </button>
        {id ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0${start ? `&start=${start}` : ""}`}
            title="YouTube video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            loading="lazy"
          />
        ) : (
          <a href={url}>{url}</a>
        )}
      </span>
    </PlacedMedia>
  );
}

/** A playable YouTube player in the note, sized and placed like photos. Stored text: ![](link). */
export const YoutubeEmbed = Node.create({
  name: "youtubeEmbed",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      ...placementAttributes(),
      url: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-youtube-embed") ?? "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-youtube-embed]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-youtube-embed": node.attrs.url, "data-width": node.attrs.width ?? undefined }), node.attrs.url];
  },
  renderText({ node }) {
    return `![${node.attrs.width ? `|${node.attrs.width}` : ""}](${node.attrs.url})`;
  },
  // Typed ![](youtube link) becomes the player once its ")" is there (also when auto-pairs typed it).
  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey("youtubeEmbedTyped"),
        appendTransaction(trs, _old, state) {
          if (!trs.some((tr) => tr.docChanged)) return null;
          const { $from } = state.selection;
          const block = $from.parent;
          if (!block.isTextblock || !block.textContent.includes("](")) return null;
          let tr: Transaction | null = null;
          block.forEach((child, offset) => {
            if (tr || !child.isText || !child.text) return;
            const m = TYPED_RE.exec(child.text);
            if (!m) return;
            const from = $from.start() + offset + m.index;
            tr = state.tr.replaceWith(from, from + m[0].length, type.create({ url: m[2], width: m[1] ? Number(m[1]) : null }));
          });
          return tr;
        },
      }),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(YoutubeView, mediaNodeViewOptions);
  },
});
