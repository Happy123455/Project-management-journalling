import { describe, expect, it } from "vitest";
import { buildAlarms, nextOccurrence, occurrences, stepDay, timesIn } from "./reminders";

const doc = (...lines: string[]) => ({ type: "doc", content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });

describe("reminders", () => {
  it("finds times written in a line, but not the timestamp of when it was written", () => {
    expect(timesIn("dentist 15:30")).toEqual([{ hour: 15, minute: 30 }]);
    expect(timesIn("call mom 3pm")).toEqual([{ hour: 15, minute: 0 }]);
    expect(timesIn("gym at 6:45 am")).toEqual([{ hour: 6, minute: 45 }]);
    expect(timesIn("meet at 4")).toEqual([{ hour: 16, minute: 0 }]);
    expect(timesIn("27,October,2026 Tuesday (22:04:26) buy milk")).toEqual([]);
    expect(timesIn("score was 3-2")).toEqual([]);
  });

  it("repeats keep the date, month ends fall on the last day", () => {
    expect(stepDay("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(stepDay("2024-02-29", "yearly")).toBe("2025-02-28");
    expect(nextOccurrence("2020-11-05", "yearly", "2026-11-01")).toBe("2026-11-05");
    expect(nextOccurrence("2026-10-01", "weekly", "2026-11-01")).toBe("2026-11-05");
    expect(occurrences("2026-10-30", "weekly", "2026-11-01", "2026-11-30")).toEqual(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
  });

  it("gives one notification per time, and a morning one when no time is written", () => {
    const now = new Date(2026, 10, 1, 10, 0);
    const alarms = buildAlarms(
      [
        { day: "2026-11-03", content: doc("dentist 15:30 with [[Ravi]]", "bring card") },
        { day: "2026-11-04", content: doc("pay rent") },
        { day: "2026-10-01", content: doc("water plants"), repeat: "weekly" },
      ],
      now,
      { days: 7 },
    );
    expect(alarms.map((a) => [new Date(a.at).toString().slice(4, 21), a.body])).toEqual([
      ["Nov 03 2026 15:30", "dentist 15:30 with Ravi"],
      ["Nov 04 2026 08:00", "pay rent"],
      ["Nov 05 2026 08:00", "water plants"],
    ]);
  });
});

import { reminderLine, timeEdit, timeSpans, todayAgenda } from "./reminders";

describe("timed reminders today", () => {
  it("finds where a time is, to change it", () => {
    expect(timeSpans("call 3pm")[0]).toMatchObject({ index: 5, length: 3 });
    expect(timeSpans("27,October,2026 Tuesday (22:04:26) gym 18:30")[0]).toMatchObject({ hour: 18, minute: 30, index: 39 });
    expect(timeEdit("dentist 15:30", 16, 5)).toEqual({ index: 8, del: 5, ins: "16:05" });
    expect(timeEdit("pay rent", 9, 0)).toEqual({ index: 0, del: 0, ins: "⏰ 09:00 " });
    expect(timeSpans("meet at 4")[0]).toMatchObject({ index: 8, length: 1 });
  });

  it("today's own note: only ⏰ lines; a reminder: timed lines without a timestamp", () => {
    expect(reminderLine("27,October,2026 Tuesday (07:04:26) woke at 7:30", true)).toBe(false);
    expect(reminderLine("dentist 15:30", true)).toBe(true);
    expect(reminderLine("dentist 15:30", false)).toBe(false);
    expect(reminderLine("⏰ 15:30 dentist", false)).toBe(true);
  });

  it("lists today's times in order, with done ones marked, and repeats that fall today", () => {
    const today = "2026-11-04";
    const items = todayAgenda(
      { content: { type: "doc", content: [...doc("⏰ 18:00 gym", "✅ ⏰ 09:00 call").content, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: doc("⏰ 12:00 lunch with Ravi").content }] }] } },
      [{ day: "2026-10-28", content: doc("standup 10:00"), repeat: "weekly" }, { day: "2026-10-29", content: doc("other 11:00"), repeat: "weekly", doneDays: [] }],
      today,
    );
    expect(items.map((i) => [i.text, i.done])).toEqual([["⏰ 09:00 call", true], ["standup 10:00", false], ["⏰ 12:00 lunch with Ravi", true], ["⏰ 18:00 gym", false]]);
    const done = todayAgenda(null, [{ day: "2026-10-28", content: doc("standup 10:00"), repeat: "weekly", doneDays: [today] }], today);
    expect(done[0].done).toBe(true);
  });

  it("today's own note rings only for ⏰ lines", () => {
    const now = new Date(2026, 10, 4, 8, 0);
    const alarms = buildAlarms([{ day: "2026-11-04", content: doc("woke 7:30, gym 18:00", "⏰ 17:00 call", "✅ ⏰ 16:00 done one"), marked: true }], now);
    expect(alarms.map((a) => a.body)).toEqual(["⏰ 17:00 call"]);
  });
});

describe("reminder times and time left", () => {
  it("finds the times a reminder rings at, earliest first, skipping done lines", async () => {
    const { reminderTimes } = await import("./reminders");
    const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const doc = { type: "doc", content: [p("dentist 17:30"), p("call mom at 9"), p("✅ old 10:00"), p("just a note")] };
    expect(reminderTimes(doc).map((t) => [t.hour, t.minute, t.text])).toEqual([[9, 0, "call mom at 9"], [17, 30, "dentist 17:30"]]);
  });
  it("says how long is left, short", async () => {
    const { timeLeft } = await import("./reminders");
    const M = 60_000;
    expect(timeLeft(-5)).toBe("now");
    expect(timeLeft(30_000)).toBe("<1m");
    expect(timeLeft(12 * M)).toBe("12m");
    expect(timeLeft(200 * M)).toBe("3h 20m");
    expect(timeLeft(60 * M)).toBe("1h");
    expect(timeLeft((4 * 1440 + 3 * 60 + 5) * M)).toBe("4d 3h");
    expect(timeLeft(2 * 1440 * M)).toBe("2d");
  });
});
