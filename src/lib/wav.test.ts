import { describe, expect, it } from "vitest";
import { base64, cutPoint, downsample, pcm16, rms, SPEECH_RATE, SpeechChunker, wavFile } from "./wav";

const tone = (sec: number, amp = 0.3, rate = SPEECH_RATE) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin((i / rate) * 2 * Math.PI * 220));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

describe("speech audio", () => {
  it("downsamples 48 kHz to 16 kHz, keeping the level", () => {
    const d = downsample(tone(1, 0.5, 48_000), 48_000);
    expect(d.length).toBe(16_000);
    expect(rms(d)).toBeGreaterThan(0.3);
  });

  it("cuts at the pause, not in the middle of a word", () => {
    const s = join(tone(14), new Float32Array(SPEECH_RATE / 2), tone(10));
    const at = cutPoint(s, SPEECH_RATE, 12, 24) / SPEECH_RATE;
    expect(at).toBeGreaterThan(14);
    expect(at).toBeLessThan(14.5);
  });

  it("writes a valid WAV header and 16-bit samples", () => {
    const w = wavFile(Float32Array.from([0, 1, -1]));
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(46, true)).toBe(0x7fff);
    expect(v.getInt16(48, true)).toBe(-0x8000);
    expect(pcm16(Float32Array.from([2])).length).toBe(2);
    expect(base64(new Uint8Array([104, 105]))).toBe("aGk=");
  });

  it("hands out pieces cut at pauses and drops silence", () => {
    const pieces: [number, number][] = [];
    const c = new SpeechChunker((s, start) => pieces.push([s.length / SPEECH_RATE, start]));
    // 30 s of speech with a pause at 15 s, then 30 s of silence, then 3 s of speech, fed in small bits.
    const all = join(tone(15), new Float32Array(SPEECH_RATE / 2), tone(15), new Float32Array(SPEECH_RATE * 30), tone(3));
    for (let i = 0; i < all.length; i += 4096) c.push(all.subarray(i, i + 4096));
    c.flush();
    expect(pieces.length).toBe(3);
    expect(pieces[0][0]).toBeGreaterThan(15);
    expect(pieces[0][0]).toBeLessThan(15.5);
    expect(pieces[0][1]).toBe(0);
    // The last piece starts where the silence ended (the silent pieces were dropped, not lost in time).
    expect(pieces[2][1]).toBeGreaterThan(50);
    expect(c.at).toBeCloseTo(all.length / SPEECH_RATE, 3);
  });
});
