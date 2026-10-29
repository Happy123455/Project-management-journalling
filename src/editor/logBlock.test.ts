import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../lib/timestamp";
import { isLogEntry } from "./logBlock";

describe("isLogEntry", () => {
  it("is a log entry only when the line starts with a timestamp", () => {
    const ts = formatTimestamp(new Date(2026, 9, 28, 9, 5, 0));
    expect(isLogEntry(`${ts} started`)).toBe(true);
    expect(isLogEntry(`note ${ts}`)).toBe(false);
    expect(isLogEntry("plain")).toBe(false);
  });
});
