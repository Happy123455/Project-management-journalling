import type { JSONContent } from "@tiptap/react";
import type { JournalEvent, JournalStore } from "../store";
import { appendBlocks, textBlocks } from "./append";
import { WIKILINK_RE } from "./links";
import { docText } from "./words";

/**
 * Recovery for the bug where coming back from a [[link]] reopened the day from a stale copy, so the
 * next save dropped what had been typed (links included). For one day: the latest earlier version
 * holding [[links]] the note no longer has, and its paragraphs that carried them.
 */
export function lostLinkBlocks(events: JournalEvent[], current: JSONContent | null): { from: JournalEvent; blocks: JSONContent[]; links: string[] } | null {
  const linksIn = (text: string) => new Set([...text.matchAll(WIKILINK_RE)].map((m) => m[0]));
  const now = current ? docText(current) : "";
  const have = linksIn(now);
  const versions = events.filter((e) => e.op === "create" || e.op === "update" || e.op === "restore");
  for (let i = versions.length - 1; i >= 0; i--) {
    let doc: JSONContent;
    try {
      doc = JSON.parse(versions[i].after) as JSONContent;
    } catch {
      continue;
    }
    const missing = [...linksIn(docText(doc))].filter((l) => !have.has(l));
    if (!missing.length) continue;
    // Only paragraphs (or lists) with a missing link and whose text isn't already in the note.
    const blocks = (doc.content ?? []).filter((b) => {
      const text = docText(b);
      return missing.some((l) => text.includes(l)) && !now.includes(text.trim());
    });
    if (blocks.length) return { from: versions[i], blocks, links: missing };
  }
  return null;
}

export interface RepairReport {
  day: string;
  /** Dry run: the paragraphs that would come back. */
  preview?: string[];
  links: string[];
  blocks: number;
  lostAt: string;
}

/** Puts lost [[link]] paragraphs back at the end of each affected day, as one "repair" event per day. */
export async function repairLostLinks(store: JournalStore, days?: string[], dryRun = false): Promise<RepairReport[]> {
  const report: RepairReport[] = [];
  for (const day of days ?? (await store.listDays())) {
    const page = await store.getDay(day);
    if (!page) continue;
    const found = lostLinkBlocks(await store.eventsFor(page.id), page.content);
    if (!found) continue;
    if (dryRun) {
      report.push({ day, links: found.links, blocks: found.blocks.length, lostAt: found.from.createdAt, preview: found.blocks.map(docText) });
      continue;
    }
    const when = new Date(found.from.createdAt).toLocaleString();
    const content = appendBlocks(page.content, [...textBlocks(`↩ Restored (lost after opening a link; from ${when}):`), ...found.blocks]);
    await store.saveDay({ day, content, plainText: docText(content), actor: "repair" });
    report.push({ day, links: found.links, blocks: found.blocks.length, lostAt: found.from.createdAt });
  }
  return report;
}
