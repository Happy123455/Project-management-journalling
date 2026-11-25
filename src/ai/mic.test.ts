import { afterEach, describe, expect, it, vi } from "vitest";
import { openMic, openMics, releaseMics } from "./mic";

/** A fake microphone: a stream whose one track can be stopped. */
function fakeMic(delay = 0) {
  const tracks: { readyState: string; stop: () => void }[] = [];
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((ok) => {
        const t = { readyState: "live", stop: () => (t.readyState = "ended") };
        tracks.push(t);
        setTimeout(() => ok({ getTracks: () => [t] } as unknown as MediaStream), delay);
      }),
  );
  vi.stubGlobal("navigator", { userAgent: "test", mediaDevices: { getUserMedia } });
  return tracks;
}

describe("the microphone register (25 Nov: still recording after closing)", () => {
  afterEach(() => {
    releaseMics("");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("closing a screen lets go of its mic, and only its own", async () => {
    const tracks = fakeMic();
    const talk = await openMic({ owner: "talk" });
    let killed = false;
    talk.onKill(() => (killed = true));
    await openMic({ owner: "agent:a1" });
    expect(openMics().map((m) => m.owner)).toEqual(["talk", "agent:a1"]);
    releaseMics("talk");
    expect(tracks[0].readyState).toBe("ended");
    expect(killed).toBe(true);
    expect(tracks[1].readyState).toBe("live");
    expect(openMics().map((m) => m.owner)).toEqual(["agent:a1"]);
  });

  it("a mic still opening when its screen closed is shut as it opens", async () => {
    const tracks = fakeMic(20);
    const opening = openMic({ owner: "agent:a2" });
    releaseMics("agent:");
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(tracks[0].readyState).toBe("ended");
    expect(openMics()).toEqual([]);
  });

  it("the watchdog closes a mic whose owner is gone", async () => {
    vi.useFakeTimers();
    const tracks = fakeMic();
    let there = true;
    const p = openMic({ owner: "assistant:bar", alive: () => there });
    await vi.advanceTimersByTimeAsync(1);
    await p;
    there = false;
    await vi.advanceTimersByTimeAsync(1600);
    expect(tracks[0].readyState).toBe("ended");
    expect(openMics()).toEqual([]);
  });
});
