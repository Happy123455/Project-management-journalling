import type { JSONContent } from "@tiptap/react";

/**
 * Every line (every block node: paragraph, heading, list, list item, photo…) carries a hidden id,
 * `lid`. A sync merge matches lines by it, so "Hel", "Hello wo" and "Hello world" saved on two
 * devices are one line in three versions, never three lines.
 *
 * A line typed in the app gets a random id. A line that has none yet (an old note, one written
 * by the AI or the routine, a Source mode read-back) gets one from its content and its place among
 * same-looking neighbours, so both devices give the same old line the same id without talking.
 */
export const LID = "lid";

/** cyrb53, as 11 base-36 characters. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

export const randomLid = () => "r" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** What a node is, without its id or when it was born: the same line on any device. */
export function contentKey(n: JSONContent): string {
  const strip = (x: JSONContent): unknown => {
    const a = { ...(x.attrs ?? {}) };
    delete a[LID];
    delete a.born;
    for (const k of Object.keys(a)) if (a[k] === null || a[k] === undefined) delete a[k];
    return [x.type, Object.keys(a).length ? Object.entries(a).sort() : 0, x.text ?? 0, x.marks ?? 0, x.content?.map(strip) ?? 0];
  };
  return JSON.stringify(strip(n));
}

/** Ids of a list of sibling nodes: their own, or the one made from content for those without. */
export function siblingIds(nodes: JSONContent[]): string[] {
  const nth = new Map<string, number>();
  const used = new Set<string>();
  return nodes.map((n) => {
    const own = n.attrs?.[LID];
    if (typeof own === "string" && own && !used.has(own)) {
      used.add(own);
      return own;
    }
    const k = contentKey(n);
    const i = (nth.get(k) ?? 0) + 1;
    nth.set(k, i);
    let id = "h" + hash(k + "#" + i);
    while (used.has(id)) id += "+";
    used.add(id);
    return id;
  });
}

const isInline = (n: JSONContent) => n.type === "text" || n.type === "hardBreak";

/** Gives every block node in a document (as JSON) an id, from content where it has none. */
export function withLineIds(doc: JSONContent): JSONContent {
  const walk = (nodes: JSONContent[]): JSONContent[] => {
    if (nodes.some(isInline)) return nodes;
    const ids = siblingIds(nodes);
    return nodes.map((n, i) => ({ ...n, attrs: { ...(n.attrs ?? {}), [LID]: ids[i] }, ...(n.content ? { content: walk(n.content) } : {}) }));
  };
  return { ...doc, content: walk(doc.content ?? []) };
}
