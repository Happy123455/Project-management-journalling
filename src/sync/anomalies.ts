/**
 * Sync anomaly log: every clash, auto-join, line removed by the other device, out-of-order or
 * unreadable arrival, with times to the millisecond, so a sync problem can be traced afterwards.
 * Kept on this device (localStorage journal.anomalies, newest first, the last 400 entries) and, on
 * Wi-Fi, copied to the sync folder as logs/<device>.json so both devices' logs can be read together.
 */
export type Path = "wifi" | "cloud" | "wifi-typing" | "save" | "local";
export type AnomalyKind =
  /** Both devices changed the same line differently: both kept, Hapi picks (see clash.ts). */
  | "clash"
  /** Both changed different parts of one line: joined letter by letter. */
  | "joined"
  /** One device deleted a line the other edited: the edited line was kept. */
  | "kept-edited"
  /** The other device's edit took lines out of this note. */
  | "lines-removed"
  /** An edit arrived after a newer one for the same note (e.g. Drive delivered it after Wi-Fi). */
  | "out-of-order"
  /** The other device's clock is ahead of this one. */
  | "clock-ahead"
  /** A sync file line or typing message that couldn't be read (waits for the next copy). */
  | "unreadable"
  /** A save from an editor that was behind the stored note was merged instead of written over. */
  | "stale-save"
  /** Hapi chose a side for a clash. */
  | "resolved";

export interface Anomaly {
  /** Date.now() when logged. */
  at: number;
  /** performance.now() (ms since the app started), for ordering within one run. */
  t: number;
  kind: AnomalyKind;
  path: Path;
  /** Which note, e.g. "day:2026-11-09". */
  note?: string;
  /** One line for the list. */
  text: string;
  /** Everything else: device ids, event times, lag, line texts. */
  detail?: Record<string, unknown>;
}

const KEY = "journal.anomalies";
const MAX = 400;
export const ANOMALY_EVENT = "journal:anomaly";

let cache: Anomaly[] | null = null;
export function anomalies(): Anomaly[] {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(v) ? v : [];
  } catch {
    cache = [];
  }
  return cache;
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Repeats of the same thing (same kind, note and text) within this long count up instead. */
const SAME_MS = 10_000;

export function logAnomaly(a: Omit<Anomaly, "at" | "t">) {
  const now = Date.now();
  const list = anomalies();
  const t = typeof performance !== "undefined" ? Math.round(performance.now() * 1000) / 1000 : 0;
  const prev = list[0];
  if (prev && prev.kind === a.kind && prev.note === a.note && prev.text === a.text && now - prev.at < SAME_MS) {
    prev.detail = { ...(prev.detail ?? {}), repeats: Number(prev.detail?.repeats ?? 1) + 1, lastAt: stamp(now) };
  } else list.unshift({ ...a, at: now, t });
  if (list.length > MAX) list.length = MAX;
  if (typeof window === "undefined") return;
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    try {
      localStorage.setItem(KEY, JSON.stringify(anomalies()));
    } catch {
      // Not kept.
    }
    window.dispatchEvent(new Event(ANOMALY_EVENT));
  }, 300);
}

export function clearAnomalies() {
  cache = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ANOMALY_EVENT));
}

/** "09 Nov 08:45:12.345" in local time (what Hapi reads). */
export function stamp(ms: number | string): string {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const mon = d.toLocaleString("en", { month: "short" });
  return `${p(d.getDate())} ${mon} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** The whole log as text, for copying into a message or a bug report. */
export function anomalyText(list = anomalies()): string {
  return list
    .map((a) => `${stamp(a.at)} [${a.path}] ${a.kind}${a.note ? ` ${a.note}` : ""}: ${a.text}${a.detail ? `\n    ${JSON.stringify(a.detail)}` : ""}`)
    .join("\n");
}

/** Short text of a line for the log. */
export const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
