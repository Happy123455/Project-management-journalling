import type { JSONContent } from "@tiptap/react";

export interface OutlineNode {
  text: string;
  children: OutlineNode[];
}

/** A Markdown bullet outline ("- a" / "  - b", or "* ", "1. ") as a tree; other lines are skipped. */
export function parseOutline(md: string): OutlineNode[] {
  const root: OutlineNode = { text: "", children: [] };
  const stack: { indent: number; node: OutlineNode }[] = [{ indent: -1, node: root }];
  for (const line of md.replace(/\t/g, "  ").split("\n")) {
    const m = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.*\S)/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const node = { text: m[2].replace(/\*\*(.+?)\*\*/g, "$1"), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root.children;
}

/** The outline as nested bullet lists for a note. */
export function outlineDoc(nodes: OutlineNode[]): JSONContent {
  return {
    type: "bulletList",
    content: nodes.map((n) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text: n.text }] }, ...(n.children.length ? [outlineDoc(n.children)] : [])],
    })),
  };
}
