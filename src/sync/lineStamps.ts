import type { JSONContent } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/**
 * Who last typed a line, and when: the hidden attr `ed` = "<device>@<ms in base 36>".
 *
 * 14 Nov (both sync logs): Hapi typed a paragraph on the phone, the Mac showed it through live
 * typing, and a few seconds later the Mac's slightly older copy ("…I don't wnasee") met the
 * phone's newer text ("…I don't want to see anything"). Neither contained the other, so the merge
 * called it a clash and kept both, the half copy above. With the stamp, the merge sees two
 * versions by the same hand and keeps the newer one; a clash is left for when the phone and the
 * Mac both really typed in the same line.
 *
 * Battery: the editor never changes `ed` while typing (an attribute change redraws the line and
 * breaks the phone keyboard's word being composed). Typing only notes which line changed
 * (`touchLines`, a map write per key); the stamp is written into the note's JSON when it is
 * saved or sent over Wi-Fi, which already happens.
 */
export const ED = "ed";

let device = "dev";
/** This device's short name in stamps (set once the store is open). */
export function setStampDevice(id: string) {
  if (id) device = id.slice(0, 8);
}
export const stampDevice = () => device;

export interface Stamp {
  device: string;
  at: number;
}

export function parseStamp(v: unknown): Stamp | null {
  if (typeof v !== "string") return null;
  const i = v.lastIndexOf("@");
  if (i <= 0) return null;
  const at = parseInt(v.slice(i + 1), 36);
  return Number.isFinite(at) ? { device: v.slice(0, i), at } : null;
}
export const stampOf = (n: JSONContent | null | undefined) => parseStamp(n?.attrs?.[ED]);
export const makeStamp = (dev: string, at: number) => `${dev}@${at.toString(36)}`;

/** Lines typed on this device, per note ("day:2026-11-16"): line id → stamp. */
const typed = new Map<string, Map<string, string>>();

/** Lines (by id) changed by this device's own typing in this note just now. */
export function touchLines(key: string, lids: Iterable<string>, now = Date.now()) {
  let m = typed.get(key);
  for (const lid of lids) {
    if (!lid) continue;
    if (!m) typed.set(key, (m = new Map()));
    m.set(lid, makeStamp(device, now));
  }
}

/** For tests. */
export function forgetStamps() {
  typed.clear();
}

/**
 * Ids of the text lines a local transaction changed (the innermost blocks with an id around
 * each changed range). Cheap: one lookup per step, nothing per line of the note.
 */
export function touchedIds(tr: Transaction, doc: PMNode): string[] {
  const out = new Set<string>();
  const maps = tr.mapping.maps;
  maps.forEach((map, i) => {
    map.forEach((_os, _oe, ns, ne) => {
      let from = ns;
      let to = ne;
      for (let j = i + 1; j < maps.length; j++) {
        from = maps[j].map(from, -1);
        to = maps[j].map(to, 1);
      }
      from = Math.max(0, Math.min(from, doc.content.size));
      to = Math.max(from, Math.min(to, doc.content.size));
      const add = (pos: number) => {
        const $p = doc.resolve(pos);
        for (let d = $p.depth; d > 0; d--) {
          const id = $p.node(d).attrs.lid;
          if (typeof id === "string" && id) return void out.add(id);
        }
      };
      add(from);
      if (to !== from) {
        add(to);
        if (to - from < 20_000)
          doc.nodesBetween(from, to, (n) => {
            if (n.isTextblock && typeof n.attrs.lid === "string" && n.attrs.lid) out.add(n.attrs.lid);
            return !n.isTextblock;
          });
      }
    });
  });
  // Attribute-only steps (a lid given to a new line) have empty maps: look at them too.
  tr.steps.forEach((s) => {
    const pos = (s as unknown as { pos?: number }).pos;
    if (typeof pos === "number" && pos >= 0 && pos < doc.content.size) {
      const n = doc.nodeAt(pos);
      if (n?.isTextblock && typeof n.attrs.lid === "string" && n.attrs.lid) out.add(n.attrs.lid);
    }
  });
  return [...out];
}

const later = (a: string | undefined, b: string | undefined) => {
  const pa = parseStamp(a);
  const pb = parseStamp(b);
  if (!pa) return b;
  if (!pb) return a;
  return pb.at > pa.at ? b : a;
};

/** The node list with this device's stamps put on the lines it typed (deep; new objects only where changed). */
export function stampNodes(key: string, nodes: JSONContent[]): JSONContent[] {
  const m = typed.get(key);
  if (!m?.size) return nodes;
  let changed = false;
  const walk = (list: JSONContent[]): JSONContent[] => {
    let any = false;
    const next = list.map((n) => {
      if (n.type === "text") return n;
      const lid = n.attrs?.lid;
      let out = n;
      const mine = typeof lid === "string" ? m.get(lid) : undefined;
      if (mine) {
        const ed = later(n.attrs?.[ED], mine);
        if (ed !== n.attrs?.[ED]) out = { ...n, attrs: { ...(n.attrs ?? {}), [ED]: ed } };
      }
      if (n.content?.length && n.content.some((c) => c.type !== "text")) {
        const kids = walk(n.content);
        if (kids !== n.content) out = { ...out, content: kids };
      }
      if (out !== n) any = true;
      return out;
    });
    if (!any) return list;
    changed = true;
    return next;
  };
  const out = walk(nodes);
  return changed ? out : nodes;
}

/** The note with this device's stamps on the lines it typed (see stampNodes). */
export function stampDoc(key: string, doc: JSONContent): JSONContent {
  const content = doc.content ? stampNodes(key, doc.content) : doc.content;
  return content === doc.content ? doc : { ...doc, content };
}

/**
 * Two versions of one line by the same device: the newer one (null when they aren't, or when
 * either has no stamp: the merge then decides as before).
 */
export function newerSameAuthor(n: JSONContent, o: JSONContent): JSONContent | null {
  const sn = stampOf(n);
  const so = stampOf(o);
  if (!sn || !so || sn.device !== so.device || sn.at === so.at) return null;
  return sn.at > so.at ? n : o;
}

/** When a line was last typed (its stamp, else when it was started): ms, or null. */
export function lineTime(n: JSONContent): number | null {
  const s = stampOf(n);
  if (s) return s.at;
  const born = n.attrs?.born;
  const t = typeof born === "string" ? Date.parse(born) : NaN;
  return Number.isFinite(t) ? t : null;
}
