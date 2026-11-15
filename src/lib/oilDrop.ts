// 🛢️ The evening oil-drop check (the "Ask why again" idea): at the end of a day the AI reads that
// day's note next to the six days before it and looks for one small, repeating crack (the drop of
// oil under the machine) before it turns into a breakdown. Most days it says "all clear": a warning
// needs a pattern, not one tired day. When it finds one, Hapi drills down with "Why?" (one sentence
// each) until the root cause shows, and the check ends with one small fix for tomorrow.
//
// This file is the pure part (records, context, prompts, schemas, normalising, the lines written in
// the journal, when the automatic check is due). src/oildrop/oilDrop.ts runs it.
import { overlap } from "./consequence";

// ───── Records ─────

export type FixKept = "kept" | "slipped" | "unclear" | "none";

export interface Drop {
  /** A repeating crack was found (false = all clear). */
  found: boolean;
  /** watch: worth noticing · warning: will cost something soon if left. */
  level: "watch" | "warning";
  confidence: number;
  /** The oil drop: the small thing noticed in the notes. */
  symptom: string;
  /** Where it shows: the day and Hapi's own words. */
  evidence: { day: string; quote: string }[];
  /** "Tightening the bolt": the lazy surface fix that leaves the cause alive. */
  trap: string;
  /** What realistically goes wrong in 2–4 weeks if the cause is ignored. */
  risk: string;
  /** The first "Why?" to trace the hidden cause. */
  why: string;
  /** One small preventive tweak for tomorrow. */
  fix: string;
  /** All clear: one calm line about the day. */
  note: string;
  /** Was the last fix followed, judging by this day's notes? */
  lastFix: FixKept;
}

export interface WhyStep {
  q: string;
  a: string;
  at: string;
}

/** The end of a drill: the root cause, what it risks, and the fix. */
export interface RootCause {
  root: string;
  risk: string;
  fix: string;
  at: string;
  by: string;
}

/** One day's check (record id = the day, so each day has one and sync merges per day). */
export interface DropRec {
  kind: "drop";
  id: string;
  day: string;
  at: string;
  by: string;
  model: string;
  /** Started by the evening timer, not a tap. */
  auto?: boolean;
  /** How many characters of the day's note were read (to offer "check again" after more writing). */
  read: number;
  drop: Drop;
  whys: WhyStep[];
  /** The next "Why?" waiting for Hapi's answer (after the first). */
  next?: string;
  final?: RootCause;
  /** Hapi said it's not a real problem: future checks learn the threshold from it. */
  dismissed?: boolean;
  /** The day the fix was put on as a reminder. */
  fixDay?: string;
}

export const DROPS_PAGE = "Oil drops";
export const MAX_WHYS = 5;

// ───── Context ─────

export interface DayText {
  day: string;
  text: string;
}

/** Lines the AI wrote (this check, the 🧯 firewall), left out so it never reads them as Hapi's. */
const own = (line: string) => /^\s*(🛢️|🧯)/u.test(line);
export const stripOwn = (text: string) =>
  text
    .split("\n")
    .filter((l) => !own(l))
    .join("\n")
    .trim();

/** How past checks went, short: the model sees repeats, kept fixes and false alarms. */
export function pastLines(records: DropRec[], before: string, max = 14): string[] {
  return records
    .filter((r) => r.day < before)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-max)
    .map((r) => {
      if (!r.drop.found) return `${r.day}: all clear`;
      const parts = [`${r.day}: ${r.dismissed ? "FALSE ALARM (Hapi said it's not a real problem): " : ""}${r.drop.symptom}`];
      if (r.final) parts.push(`root cause: ${r.final.root}`, `fix: ${r.final.fix}`);
      else if (r.drop.fix) parts.push(`suggested fix: ${r.drop.fix}`);
      if (r.drop.lastFix !== "none") parts.push(`(the fix before it was ${r.drop.lastFix})`);
      return parts.join(" · ");
    });
}

/** The fix Hapi is meant to be following on `day` (the latest one before it). */
export function activeFix(records: DropRec[], day: string): string {
  const r = records
    .filter((x) => x.day < day && x.drop.found && !x.dismissed)
    .sort((a, b) => a.day.localeCompare(b.day))
    .pop();
  return r ? r.final?.fix || r.drop.fix : "";
}

/** The day's note in full (up to a limit) and the days before it, newest kept first when space runs out. */
export function checkContext(o: { day: string; days: DayText[]; records: DropRec[]; budget: number }): { text: string; read: number } {
  const target = o.days.find((d) => d.day === o.day);
  const todayText = stripOwn(target?.text ?? "");
  const room = Math.max(4000, o.budget);
  const main = todayText.slice(0, Math.round(room * 0.45));
  let left = room - main.length;
  const before: string[] = [];
  for (const d of o.days.filter((x) => x.day < o.day).sort((a, b) => b.day.localeCompare(a.day))) {
    const t = stripOwn(d.text);
    if (!t) continue;
    const piece = t.slice(0, Math.min(6000, left));
    if (piece.length < 200 && left < 200) break;
    before.unshift(`── ${d.day} ──\n${piece}`);
    left -= piece.length;
    if (left <= 0) break;
  }
  const past = pastLines(o.records, o.day);
  const fix = activeFix(o.records, o.day);
  const text = [
    `The day to check: ${o.day}`,
    `\n══ ${o.day} (the day to check) ══\n${main || "(empty)"}`,
    before.length ? `\n══ The days before it (for patterns) ══\n${before.join("\n\n")}` : "\n(No notes from the days before.)",
    past.length ? `\n══ Past checks ══\n${past.join("\n")}` : "",
    fix ? `\nThe fix Hapi was meant to follow: ${fix}\nSay in lastFix whether ${o.day}'s note shows it was kept or slipped (unclear if it doesn't say).` : "\nNo earlier fix to follow: lastFix = none.",
  ].join("\n");
  return { text, read: todayText.length };
}

// ───── Prompts and schemas ─────

export const CHECK_SYSTEM = `You are the evening oil-drop check in Hapi's journal: a calm 5-Whys root-cause analyst. A worker once noticed one drop of oil under a machine; looking past the leaking bolt and the worn gasket, he found a bad batch from a supplier before it caused a breakdown. You look for that drop in Hapi's day.

Read the day's note next to the days before it. Look for ONE small, repeating crack in how Hapi's days run: the same slip, delay, avoidance, conflict, health or money leak showing up again, or a small new signal that clearly points at something bigger. Quote Hapi's own words as evidence (with the day).

Rules:
- Most days are fine. Normal tiredness, one bad mood, a busy day or ordinary friction is NOT a drop. Set found = false and write one short, calm note about the day instead. Never invent a risk to have something to say.
- found = true only when the pattern shows on at least two days, or one clear signal is serious. Then confidence 0–100 is how sure you are.
- Respect past checks: don't flag again what Hapi marked a false alarm unless it clearly got worse; if a fix keeps slipping, that itself can be the drop.
- No catastrophising, no lectures, no therapy talk. It's read at bedtime: plain, short, kind and exact.
- trap: the lazy surface fix that would leave the cause alive (tightening the bolt).
- risk: what realistically goes wrong in 2–4 weeks if the cause is ignored. Concrete, not dramatic.
- why: ONE sharp "Why…?" question Hapi answers in a sentence, aimed past the symptom.
- fix: ONE small preventive tweak for tomorrow, doable in under 15 minutes or a change of order/place/time.
Talk to Hapi as "you". Write in the language Hapi writes in.`;

const str = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties) });

export const CHECK_SCHEMA = obj({
  found: { type: "boolean" },
  level: { type: "string", enum: ["watch", "warning"] },
  confidence: { type: "integer" },
  symptom: str,
  evidence: { type: "array", items: obj({ day: str, quote: str }) },
  trap: str,
  risk: str,
  why: str,
  fix: str,
  note: str,
  lastFix: { type: "string", enum: ["kept", "slipped", "unclear", "none"] },
});

export const CHECK_SHAPE = `Answer with only one JSON object, no other text:
{"found": true|false, "level": "watch"|"warning", "confidence": 0-100, "symptom": "...", "evidence": [{"day": "YYYY-MM-DD", "quote": "..."}], "trap": "...", "risk": "...", "why": "Why ...?", "fix": "...", "note": "...", "lastFix": "kept"|"slipped"|"unclear"|"none"}`;

export const DRILL_SYSTEM = `You run the "Ask why again" drill in Hapi's journal. You get the oil drop found in Hapi's notes and the whys so far, each with Hapi's one-sentence answer. Each answer usually names the next layer down; ask "Why…?" about THAT, never the same question again. Stop (done = true) when the answer reaches something Hapi can change (a habit, a setup, a rule, a belief, a missing system), or when the answers stop going deeper, or after 5 whys.
When done: root = the root cause in one plain sentence (Hapi's own terms), risk = what it costs within 2–4 weeks if left, fix = one small concrete change for tomorrow that works on the root, not the symptom. Not done: question = the next single "Why…?" (short), root/risk/fix = "".
Plain, short and kind. Talk to Hapi as "you".`;

export const DRILL_SCHEMA = obj({ done: { type: "boolean" }, question: str, root: str, risk: str, fix: str });
export const DRILL_SHAPE = `Answer with only one JSON object: {"done": true|false, "question": "Why ...?", "root": "...", "risk": "...", "fix": "..."}`;

export function drillText(r: DropRec, force = false): string {
  return [
    `Oil drop (${r.day}): ${r.drop.symptom}`,
    r.drop.evidence.length ? `Seen in: ${r.drop.evidence.map((e) => `${e.day} "${e.quote}"`).join("; ")}` : "",
    `Surface fix to avoid: ${r.drop.trap}`,
    "",
    ...r.whys.map((w, i) => `Why ${i + 1}: ${w.q}\nHapi: ${w.a}`),
    force || r.whys.length >= MAX_WHYS ? "\nThat's enough whys: done = true now, with the best root cause the answers support." : "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

// ───── Normalising ─────

const text = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clamp = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : 0);

/** Below this the check counts as all clear, whatever the model said. */
export const MIN_CONFIDENCE = 55;

export function normalizeDrop(raw: unknown): Drop {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const confidence = clamp(r.confidence);
  const symptom = text(r.symptom, 400);
  const found = r.found === true && !!symptom && confidence >= MIN_CONFIDENCE;
  const lastFix = r.lastFix === "kept" || r.lastFix === "slipped" || r.lastFix === "unclear" ? r.lastFix : "none";
  return {
    found,
    level: r.level === "warning" ? "warning" : "watch",
    confidence,
    symptom: found ? symptom : "",
    evidence: found
      ? (Array.isArray(r.evidence) ? r.evidence : [])
          .map((e) => ({ day: text((e as Record<string, unknown>)?.day, 10), quote: text((e as Record<string, unknown>)?.quote, 300) }))
          .filter((e) => e.quote)
          .slice(0, 4)
      : [],
    trap: found ? text(r.trap) : "",
    risk: found ? text(r.risk) : "",
    why: found ? text(r.why, 300) || "Why does this keep happening?" : "",
    fix: found ? text(r.fix) : "",
    note: text(r.note, 300) || (found ? "" : "All clear."),
    lastFix,
  };
}

export function normalizeDrill(raw: unknown, force: boolean): { done: boolean; question: string; root: string; risk: string; fix: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const root = text(r.root, 500);
  const question = text(r.question, 300);
  const done = (r.done === true || force || !question) && !!root;
  return { done, question: done ? "" : question, root: done ? root : "", risk: done ? text(r.risk) : "", fix: done ? text(r.fix) : "" };
}

// ───── What it shows and writes ─────

/** Earlier days with a similar drop (by words shared), newest first. */
export function similarDrops(records: DropRec[], r: DropRec, threshold = 0.34): DropRec[] {
  if (!r.drop.found) return [];
  return records
    .filter((x) => x.day < r.day && x.drop.found && overlap(`${x.drop.symptom} ${x.final?.root ?? ""}`, `${r.drop.symptom} ${r.final?.root ?? ""}`) >= threshold)
    .sort((a, b) => b.day.localeCompare(a.day));
}

/** The lines added to the day's note when a drill ends (Hapi's answers included, so they're in the journal). */
export function rootLines(r: DropRec): string[] {
  if (!r.final) return [];
  return [
    `🛢️ Oil drop: ${r.drop.symptom}`,
    ...r.whys.map((w) => `🛢️ ${w.q} → ${w.a.replace(/\s+/g, " ")}`),
    `🛢️ Root cause: ${r.final.root}`,
    r.final.risk ? `🛢️ If left: ${r.final.risk}` : "",
    `🛢️ Fix: ${r.final.fix}`,
  ].filter(Boolean);
}

/** The reminder put on the fix day (a line on a future day is a reminder in this journal). */
export const fixLine = (fix: string) => `🛢️ Today's fix: ${fix.replace(/\s+/g, " ")}`;

/** The day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function prevDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ───── The automatic check ─────

/** Notes shorter than this aren't worth a check. */
export const MIN_CHARS = 150;

/**
 * Which day the evening check should run for now, or null: today once the hour has come, else
 * yesterday if it was missed (the app wasn't open that evening). Never a day that has a check, an
 * empty day, or one tried twice already on this device.
 */
export function dueDay(o: { now: Date; hour: number; today: string; has: (day: string) => boolean; chars: (day: string) => number; tries: (day: string) => number }): string | null {
  const candidates = o.now.getHours() >= o.hour ? [o.today, prevDay(o.today)] : [prevDay(o.today)];
  for (const day of candidates) {
    if (o.has(day) || o.tries(day) >= 2) continue;
    if (o.chars(day) >= MIN_CHARS) return day;
  }
  return null;
}

/** Milliseconds until the check hour today (null when it has passed). */
export function untilHour(now: Date, hour: number): number | null {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  const ms = at.getTime() - now.getTime();
  return ms > 0 ? ms : null;
}
