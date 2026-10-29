import { useEffect, useState } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { appendBlocks } from "../lib/append";
import { parseMeta, youtubeId, youtubeThumbnail, type LinkMeta } from "../lib/linkPreview";
import { formatTimestamp } from "../lib/timestamp";
import { showToast } from "../lib/toast";
import { docText } from "../lib/words";
import { journalStore } from "./attachments";

const inApp = () => "__TAURI_INTERNALS__" in window;

/** Fetches a page's title and image. Uses the app's own HTTP (pages don't allow reading from a web view). */
export async function fetchMeta(url: string): Promise<LinkMeta | null> {
  const get = inApp() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  const id = youtubeId(url);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    if (id) {
      const res = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: controller.signal });
      const body = res.ok ? await res.json() : null;
      return { title: body?.title ?? null, site: body?.author_name ? `YouTube · ${body.author_name}` : "YouTube", image: youtubeThumbnail(id) };
    }
    const res = await get(url, { signal: controller.signal, headers: { Accept: "text/html" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const meta = parseMeta(await res.text(), url);
    return meta.title || meta.image ? meta : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function openLink(url: string) {
  if (inApp()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** "Watched": logs the video with the time on the "YouTube" page. */
async function logWatched(url: string, title: string | null) {
  const store = journalStore();
  if (!store) return;
  const page = await store.ensurePage("YouTube");
  const fresh = (await store.getPage("YouTube")) ?? page;
  const line = {
    type: "bulletList",
    content: [
      {
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: `${formatTimestamp(new Date())} Watched ` },
              { type: "text", text: title || url, marks: [{ type: "link", attrs: { href: url } }] },
            ],
          },
        ],
      },
    ],
  };
  const content = appendBlocks(fresh.content, [line]);
  await store.savePage({ id: page.id, content, plainText: docText(content) });
  showToast("Logged on your YouTube page");
}

function LinkCardView({ node, updateAttributes }: NodeViewProps) {
  const { url, title, site, image, status } = node.attrs as { url: string; title: string | null; site: string | null; image: string | null; status: string };
  const [broken, setBroken] = useState(false);
  const video = youtubeId(url);

  // First time this card is seen: look up the page once and keep what was found.
  useEffect(() => {
    if (status !== "loading") return;
    let live = true;
    fetchMeta(url).then((meta) => {
      if (!live) return;
      updateAttributes(meta ? { ...meta, status: "ready" } : { status: "plain" });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, status]);

  if (status === "plain") {
    return (
      <NodeViewWrapper className="link-plain">
        <a href={url} onClick={(e) => (e.preventDefault(), void openLink(url))}>{url}</a>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper className={video ? "link-card youtube" : "link-card"} data-drag-handle="">
      <button type="button" className="link-card-main" contentEditable={false} onClick={() => void openLink(url)}>
        {image && !broken && (
          <span className="link-card-image">
            <img src={image} alt="" loading="lazy" onError={() => setBroken(true)} />
            {video && <span className="link-card-play">▶</span>}
          </span>
        )}
        <span className="link-card-text">
          <span className="link-card-title">{status === "loading" ? "Loading preview…" : title || url}</span>
          <span className="link-card-site">{site ?? url}</span>
        </span>
      </button>
      {video && status === "ready" && (
        <button type="button" className="link-card-watched" contentEditable={false} onClick={() => void logWatched(url, title)}>
          ✓ Watched
        </button>
      )}
    </NodeViewWrapper>
  );
}

/** A pasted link shown as a preview card (title, site, image), or as a plain link when the page has none. */
export const LinkCard = Node.create({
  name: "linkCard",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      url: { default: "", parseHTML: (el) => el.getAttribute("data-url") ?? el.getAttribute("href") ?? "" },
      title: { default: null, parseHTML: (el) => el.getAttribute("data-title") },
      site: { default: null, parseHTML: (el) => el.getAttribute("data-site") },
      image: { default: null, parseHTML: (el) => el.getAttribute("data-image") },
      status: { default: "loading", parseHTML: (el) => el.getAttribute("data-status") ?? "loading" },
    };
  },
  parseHTML() {
    return [{ tag: "a[data-link-card]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-link-card": "",
        href: a.url,
        "data-url": a.url,
        "data-title": a.title,
        "data-site": a.site,
        "data-image": a.image,
        "data-status": a.status,
      }),
      a.title || a.url,
    ];
  },
  // Copied as plain text, a card is just its link.
  renderText({ node }) {
    return node.attrs.url;
  },
  addNodeView() {
    return ReactNodeViewRenderer(LinkCardView);
  },
});

export const isLoneUrl = (text: string) => /^https?:\/\/\S+$/i.test(text.trim());

export interface YoutubePreview {
  id: string;
  title: string | null;
  channel: string | null;
  avatar: string | null;
  thumbnail: string;
  views: number | null;
}
const youtubeCache = new Map<string, Promise<YoutubePreview | null>>();

/** Everything shown before pasting a YouTube link: from oEmbed, the channel page and the watch page (no API key). */
export function youtubePreview(url: string): Promise<YoutubePreview | null> {
  const id = youtubeId(url);
  if (!id) return Promise.resolve(null);
  if (!youtubeCache.has(id)) {
    youtubeCache.set(
      id,
      (async () => {
        const get = inApp() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
        const text = async (u: string) => {
          try {
            const res = await get(u, { signal: AbortSignal.timeout(10000), headers: { Accept: "text/html", "Accept-Language": "en" } });
            return res.ok ? await res.text() : "";
          } catch {
            return "";
          }
        };
        let oembed: { title?: string; author_name?: string; author_url?: string } = {};
        try {
          oembed = JSON.parse(await text(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`));
        } catch {
          // Leave the details out.
        }
        const [watch, channel] = await Promise.all([text(`https://www.youtube.com/watch?v=${id}`), oembed.author_url ? text(oembed.author_url) : Promise.resolve("")]);
        const views = /"viewCount":"(\d+)"/.exec(watch)?.[1];
        return {
          id,
          title: oembed.title ?? null,
          channel: oembed.author_name ?? null,
          avatar: channel ? parseMeta(channel, oembed.author_url!).image ?? null : null,
          thumbnail: youtubeThumbnail(id),
          views: views ? Number(views) : null,
        };
      })(),
    );
  }
  return youtubeCache.get(id)!;
}

/** The preview card for a copied YouTube link. */
export function YoutubeCard({ url }: { url: string }) {
  const [p, setP] = useState<YoutubePreview | null>(null);
  useEffect(() => {
    let live = true;
    void youtubePreview(url).then((x) => live && setP(x));
    return () => {
      live = false;
    };
  }, [url]);
  const id = youtubeId(url);
  return (
    <span className="yt-card">
      <img className="yt-thumb" src={p?.thumbnail ?? (id ? youtubeThumbnail(id) : "")} alt="" />
      <span className="yt-info">
        <span className="yt-title">{p?.title ?? "YouTube video"}</span>
        <span className="yt-channel">
          {p?.avatar && <img src={p.avatar} alt="" />}
          {p?.channel ?? (p ? "" : "Loading…")}
        </span>
        {p?.views != null && <span className="yt-views">{new Intl.NumberFormat(undefined, { notation: "compact" }).format(p.views)} views</span>}
      </span>
    </span>
  );
}
