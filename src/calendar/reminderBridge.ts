import { buildAlarms, nextOccurrence, type Alarm } from "../lib/reminders";
import { addDays } from "../lib/timestamp";
import { docText } from "../lib/words";
import { showToast } from "../lib/toast";
import type { DayPage } from "../store";
import type { UpcomingPage } from "./Upcoming";

declare global {
  interface Window {
    /** Android: reminder notifications and the Coming up home-screen widget (MainActivity.kt ReminderBridge). */
    JournalReminders?: {
      schedule(json: string): void;
      setUpcoming(json: string): void;
      takeOpenDay(): string;
      askNotify(): void;
    };
  }
}

/** Coming up: reminders still ahead, and repeating ones at their next day, soonest first. */
export function upcomingFrom(reminders: DayPage[], today: string): UpcomingPage[] {
  const out: UpcomingPage[] = [];
  for (const r of reminders) {
    if (r.props.repeat) {
      const next = nextOccurrence(r.day, r.props.repeat, addDays(today, 1));
      out.push(next === r.day ? r : { ...r, day: next, repeatOf: r.day });
    } else if (r.day > today) out.push(r);
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

let asked = false;
let lastAlarms: Alarm[] = [];
let lastSent = "";

/** Hands the notifications and the widget's rows to the phone (and remembers them for the Mac's in-app nudges). */
export function publishReminders(reminders: DayPage[], today: string) {
  const alarms = buildAlarms(reminders.map((r) => ({ day: r.day, content: r.content, repeat: r.props.repeat })), new Date());
  lastAlarms = alarms;
  const rows = upcomingFrom(reminders, today).slice(0, 6).map((p) => ({
    day: p.repeatOf ?? p.day,
    label: new Date(`${p.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
    text: (docText(p.content).split("\n").find((l) => l.trim()) ?? "").replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => b || a).slice(0, 80),
    left: Math.round((Date.parse(`${p.day}T12:00:00`) - Date.parse(`${today}T12:00:00`)) / 86_400_000),
    repeat: !!p.props.repeat,
  }));
  const bridge = window.JournalReminders;
  if (!bridge) return;
  const payload = JSON.stringify(alarms);
  if (payload !== lastSent) {
    lastSent = payload;
    try {
      bridge.schedule(payload);
    } catch {
      // An older app without the bridge method.
    }
  }
  try {
    bridge.setUpcoming(JSON.stringify(rows));
  } catch {
    // ditto
  }
  if (alarms.length && !asked) {
    asked = true;
    try {
      bridge.askNotify();
    } catch {
      // ditto
    }
  }
}

/** Mac (no system scheduling here): while the app is open, a reminder's time shows as a toast. */
export function startInAppNudges(open: (day: string) => void): () => void {
  if (window.JournalReminders) return () => {};
  const fired = new Set<string>();
  const tick = () => {
    const now = Date.now();
    for (const a of lastAlarms) {
      if (a.at > now || now - a.at > 5 * 60_000 || fired.has(a.id)) continue;
      fired.add(a.id);
      showToast(`${a.title} ${a.body}`);
      try {
        if ("Notification" in window && Notification.permission === "granted") new Notification(a.title, { body: a.body }).onclick = () => open(a.day);
      } catch {
        // No system notifications in this web view.
      }
    }
  };
  const t = window.setInterval(tick, 30_000);
  return () => window.clearInterval(t);
}
