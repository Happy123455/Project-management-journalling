import { describe, expect, it } from "vitest";
import { describeSchedule, missedRun, nextRun, parseSchedule, splitSchedule } from "./schedule";

// Monday 16 Nov 2026, 10:00.
const now = new Date(2026, 10, 16, 10, 0);

describe("schedules in words", () => {
  it("reads repeating ones", () => {
    expect(parseSchedule("every day at 9 pm", now)).toEqual({ repeat: "daily", minute: 21 * 60 });
    expect(parseSchedule("daily 21:30", now)).toEqual({ repeat: "daily", minute: 21 * 60 + 30 });
    expect(parseSchedule("weekdays 7:30am", now)).toEqual({ repeat: "days", days: [1, 2, 3, 4, 5], minute: 450 });
    expect(parseSchedule("every mon and thu at 18:00", now)).toEqual({ repeat: "days", days: [1, 4], minute: 1080 });
    expect(parseSchedule("every morning", now)).toEqual({ repeat: "daily", minute: 480 });
    expect(parseSchedule("weekends at 10am", now)).toEqual({ repeat: "days", days: [0, 6], minute: 600 });
  });
  it("reads one-offs", () => {
    expect(parseSchedule("today at 6 pm", now)).toEqual({ repeat: "once", day: "2026-11-16", minute: 1080 });
    expect(parseSchedule("tomorrow 8am", now)).toEqual({ repeat: "once", day: "2026-11-17", minute: 480 });
    expect(parseSchedule("at 9am", now)).toEqual({ repeat: "once", day: "2026-11-17", minute: 540 });
    expect(parseSchedule("on 20 nov at 9:00", now)).toEqual({ repeat: "once", day: "2026-11-20", minute: 540 });
    expect(parseSchedule("on friday at 9:00", now)).toEqual({ repeat: "once", day: "2026-11-20", minute: 540 });
    expect(parseSchedule("tonight", now)).toEqual({ repeat: "once", day: "2026-11-16", minute: 1260 });
  });
  it("refuses what isn't a schedule", () => {
    expect(parseSchedule("summarise today", now)).toBeNull();
    expect(parseSchedule("every day", now)).toBeNull();
    expect(parseSchedule("buy 9 apples", now)).toBeNull();
  });
  it("takes a schedule off a command", () => {
    expect(splitSchedule("every day at 9 pm summarise today and read it", now)).toEqual({ schedule: { repeat: "daily", minute: 1260 }, rest: "summarise today and read it" });
    expect(splitSchedule("summarise today, every day at 9pm", now)?.rest).toBe("summarise today");
    expect(splitSchedule("find tasks\nopen today\nweekdays 7:30", now)).toEqual({ schedule: { repeat: "days", days: [1, 2, 3, 4, 5], minute: 450 }, rest: "find tasks\nopen today" });
    expect(splitSchedule("open yesterday", now)).toBeNull();
  });
  it("finds the next run and missed runs", () => {
    expect(nextRun({ repeat: "daily", minute: 600 }, now)).toEqual(new Date(2026, 10, 17, 10, 0));
    expect(nextRun({ repeat: "days", days: [5], minute: 60 }, now)).toEqual(new Date(2026, 10, 20, 1, 0));
    expect(nextRun({ repeat: "once", day: "2026-11-15", minute: 60 }, now)).toBeNull();
    expect(missedRun({ repeat: "daily", minute: 540 }, new Date(2026, 10, 14, 12), now)).toEqual(new Date(2026, 10, 16, 9, 0));
    expect(missedRun({ repeat: "daily", minute: 660 }, new Date(2026, 10, 16, 9), now)).toBeNull();
    expect(describeSchedule({ repeat: "days", days: [1, 4], minute: 1080 })).toBe("every Mon, Thu at 18:00");
  });
});
