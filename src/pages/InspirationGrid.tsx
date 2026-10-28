import type { JSONContent } from "@tiptap/react";
import { useFileUrl } from "../editor/attachments";
import { inspirationItems } from "../editor/inspiration";
import { openLink } from "../editor/linkCard";
import { docText } from "../lib/words";

function find(blocks: JSONContent[], test: (n: JSONContent) => boolean): JSONContent | null {
  for (const b of blocks) {
    if (test(b)) return b;
    const inner = b.content ? find(b.content, test) : null;
    if (inner) return inner;
  }
  return null;
}

function Card({ blocks }: { blocks: JSONContent[] }) {
  const image = find(blocks, (n) => n.type === "attachmentImage");
  const link = find(blocks, (n) => n.type === "linkCard");
  const { url } = useFileUrl(image?.attrs?.fileId ?? null);
  const text = blocks.map(docText).join("\n").trim();
  const picture = url ?? link?.attrs?.image ?? null;
  return (
    <button type="button" className="inspiration-card" onClick={() => link && void openLink(link.attrs!.url)}>
      {picture && <img src={picture} alt="" loading="lazy" />}
      {(text || link?.attrs?.title) && <span className="inspiration-text">{text || link!.attrs!.title}</span>}
    </button>
  );
}

/** The Inspiration page as a grid of saved items. */
export function InspirationGrid({ content }: { content: JSONContent }) {
  const items = inspirationItems(content);
  if (!items.length) return <p className="hint">Tap ✨ (or "/" → Inspiration) on any block to save it here.</p>;
  return <div className="inspiration-grid">{items.map((blocks, i) => <Card key={i} blocks={blocks} />)}</div>;
}
