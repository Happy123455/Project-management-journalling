import type { JSONContent } from "@tiptap/react";

/** Words in a piece of text; anything separated by whitespace counts as one word. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Plain text of a stored TipTap document, with blocks separated by newlines. */
export function docText(node: JSONContent): string {
  if (node.text) return node.text;
  return (node.content ?? []).map(docText).join("\n");
}

/**
 * Shade for a heat-map cell: 0 when nothing was written, otherwise between a faint
 * 0.15 and 1 for the busiest day in the range being compared.
 */
export function heat(words: number, max: number): number {
  if (words <= 0 || max <= 0) return 0;
  return 0.15 + 0.85 * Math.min(words / max, 1);
}
