// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast, subscribeToasts, waitingToasts, type Toast } from "./toast";

describe("background notices while typing", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("wait while you type, show once you stop; your own actions show at once", () => {
    vi.useFakeTimers();
    let seen: Toast[] = [];
    const stop = subscribeToasts((t) => (seen = t));
    document.body.innerHTML = `<div class="tiptap" contenteditable="true" tabindex="0">Hi</div>`;
    const ed = document.querySelector<HTMLElement>(".tiptap")!;
    ed.focus();
    // Shown at once when you aren't typing yet, even in the editor.
    showToast("📋 Copied from Mac: “a”", "info", undefined, { background: true });
    expect(seen.map((t) => t.message)).toContain("📋 Copied from Mac: “a”");
    vi.advanceTimersByTime(4000);
    // Typing now.
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    showToast("📥 Text from Mac · in Nexus › Send", "info", undefined, { background: true });
    showToast("Saved", "info");
    expect(seen.map((t) => t.message)).toEqual(["Saved"]);
    expect(waitingToasts()).toEqual(["📥 Text from Mac · in Nexus › Send"]);
    // Still typing a second later: still waiting.
    vi.advanceTimersByTime(1000);
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    vi.advanceTimersByTime(2000);
    expect(waitingToasts()).toHaveLength(1);
    // A pause: it shows.
    vi.advanceTimersByTime(3000);
    expect(waitingToasts()).toEqual([]);
    expect(seen.map((t) => t.message)).toContain("📥 Text from Mac · in Nexus › Send");
    stop();
  });
});
