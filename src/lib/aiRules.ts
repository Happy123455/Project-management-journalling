// AI navigation rules: the "AI rules" page says which note or project to open by itself, when.
// One rule per line, for example:
//   on open → today
//   weekdays 09:00 open [[Work log]]
//   sat, sun 10:30 → [[Weekend plans]]
//   21:30 open [[Evening review]]
// The app follows them when it opens or comes back, and at the time (never while you type).
// The AI chat can add rules too (add_rule), and opens notes directly with open_note.

export const RULES_PAGE = "AI rules";

export type RuleWhen = { kind: "open" } | { kind: "time"; minutes: number };

export interface AiRule {
  /** The line as written (also the rule's identity). */
  line: string;
  /** Days of the week it applies on (0 = Sunday); empty = every day. */
  days: number[];
  when: RuleWhen;
  /** "today", "yesterday", "tomorrow", a YYYY-MM-DD day, or a page or project title. */
  target: string;
}

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseDays(words: string): number[] | null {
  const w = words.trim().toLowerCase();
  if (!w || w === "daily" || w === "every day" || w === "everyday") return [];
  if (w === "weekdays") return [1, 2, 3, 4, 5];
  if (w === "weekends" || w === "weekend") return [0, 6];
  const out: number[] = [];
  for (const part of w.split(/[\s,/&]+|\band\b/).filter(Boolean)) {
    const d = DAY_NAMES[part.slice(0, 3)];
    if (d === undefined) return null;
    out.push(d);
  }
  return [...new Set(out)].sort();
}

/** A rule from one line, or null when the line isn't one. */
export function parseRule(line: string): AiRule | null {
  const s = line.replace(/^[\s\-*•·]+/, "").trim();
  // "<days> <when> (open|→|->|go to|show) <target>"
  const m = /^(.*?)\b(on open|when (?:the app |i )?opens?|at start|(\d{1,2})[:.](\d{2})\s*(am|pm)?)\s*(?:→|->|=>|:|\bopen\b|\bgo to\b|\bshow\b)\s*(.+)$/i.exec(s);
  if (!m) return null;
  const days = parseDays(m[1].replace(/\b(at|every)\b/gi, "").trim());
  if (!days) return null;
  let when: RuleWhen;
  if (m[3] !== undefined) {
    let h = Number(m[3]);
    const min = Number(m[4]);
    const ap = m[5]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    when = { kind: "time", minutes: h * 60 + min };
  } else when = { kind: "open" };
  let target = m[6].replace(/^(?:\bopen\b|\bgo to\b|\bshow\b|→|->)\s*/i, "").trim();
  const link = /^\[\[([^\]]+)\]\]/.exec(target);
  if (link) target = link[1].trim();
  target = target.replace(/^(?:the\s+)?(?:project|note|page)\s+/i, "").replace(/[.!]+$/, "").trim();
  if (!target) return null;
  return { line: s, days, when, target };
}

export const parseRules = (lines: string[]): AiRule[] => lines.map(parseRule).filter((r): r is AiRule => !!r);

/** The day a relative target means, as YYYY-MM-DD; null for page titles. */
export function targetDay(target: string, now: Date): string | null {
  const t = target.toLowerCase();
  const shift = t === "today" ? 0 : t === "yesterday" ? -1 : t === "tomorrow" ? 1 : null;
  if (shift === null) return /^\d{4}-\d{2}-\d{2}$/.test(target) ? target : null;
  const d = new Date(now);
  d.setDate(d.getDate() + shift);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dayStamp = (now: Date) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

/**
 * The rule to follow now, if any. `opening`: the app just opened or came back. A time rule counts
 * from its minute until two hours later (the app may have been closed at the time), once a day.
 * The most recent due rule wins; `fired` holds "line|day" keys already followed.
 */
export function dueRule(rules: AiRule[], now: Date, opening: boolean, fired: Set<string>): AiRule | null {
  const minute = now.getHours() * 60 + now.getMinutes();
  const today = dayStamp(now);
  let best: { rule: AiRule; at: number } | null = null;
  for (const r of rules) {
    if (r.days.length && !r.days.includes(now.getDay())) continue;
    if (fired.has(`${r.line}|${today}`)) continue;
    if (r.when.kind === "open") {
      if (opening && (!best || best.at < 0)) best = { rule: r, at: -1 };
      continue;
    }
    const since = minute - r.when.minutes;
    if (since < 0 || since > 120) continue;
    // Only right at the time, unless the app is just opening (then a missed one still counts).
    if (!opening && since > 1) continue;
    if (!best || r.when.minutes > best.at) best = { rule: r, at: r.when.minutes };
  }
  return best?.rule ?? null;
}

export const firedKey = (r: AiRule, now: Date) => `${r.line}|${dayStamp(now)}`;
