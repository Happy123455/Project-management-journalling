/** What a link card shows. */
export interface LinkMeta {
  title: string | null;
  site: string | null;
  image: string | null;
}

/** The video id of a YouTube watch, short or Shorts link, or null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/);
      return m?.[1] ?? null;
    }
  } catch {
    // Not a URL.
  }
  return null;
}

export const youtubeThumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/** Title, site name and preview image from a page's <head> (Open Graph, Twitter or plain tags). */
export function parseMeta(html: string, pageUrl: string): LinkMeta {
  const head = html.slice(0, 300_000);
  const meta = (names: string[]) => {
    for (const name of names) {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
      const tag = head.match(re)?.[0];
      const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
      if (content) return decode(content);
    }
    return null;
  };
  const title = meta(["og:title", "twitter:title"]) ?? (head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decode(head.match(/<title[^>]*>([^<]*)<\/title>/i)![1]) : null);
  const image = meta(["og:image", "og:image:url", "twitter:image"]);
  let site = meta(["og:site_name"]);
  try {
    site ??= new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    // Keep null.
  }
  let absoluteImage: string | null = null;
  try {
    absoluteImage = image ? new URL(image, pageUrl).href : null;
  } catch {
    absoluteImage = null;
  }
  return { title: title || null, site, image: absoluteImage };
}
