import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissToast, showToast, subscribeToasts, type Toast } from "./toast";

describe("toasts", () => {
  afterEach(() => vi.useRealTimers());

  it("shows, de-duplicates, auto-hides and can be closed", () => {
    vi.useFakeTimers();
    let seen: Toast[] = [];
    const stop = subscribeToasts((t) => (seen = t));
    showToast("Saved elsewhere");
    const id = showToast("Save failed: disk full", "error");
    showToast("Save failed: disk full", "error");
    expect(seen.map((t) => t.message)).toEqual(["Saved elsewhere", "Save failed: disk full"]);
    vi.advanceTimersByTime(3600);
    expect(seen.map((t) => t.message)).toEqual(["Save failed: disk full"]);
    dismissToast(seen[0].id);
    expect(seen).toEqual([]);
    dismissToast(id);
    stop();
  });
});
