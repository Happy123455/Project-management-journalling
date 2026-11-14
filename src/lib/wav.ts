/**
 * Audio for speech recognition: 16 kHz mono, cut into pieces at pauses (Whisper reads up to 30 s
 * at a time), as 16-bit PCM (for the Mac's Whisper) or a WAV file (for Gemini).
 */

export const SPEECH_RATE = 16_000;

/** `input` at `from` Hz as `to` Hz (averaging each step, which also filters the highs a little). */
export function downsample(input: Float32Array, from: number, to = SPEECH_RATE): Float32Array {
  if (from === to) return input.slice();
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = b > a ? sum / (b - a) : input[a] ?? 0;
  }
  return out;
}

/** Loudness (root mean square) of samples [a, b). */
export function rms(s: Float32Array, a = 0, b = s.length): number {
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / (b - a));
}

/**
 * Where to cut a piece: the quietest 200 ms between `minSec` and `maxSec` (a pause, so no word is
 * split), or `maxSec` when the audio is shorter than that.
 */
export function cutPoint(s: Float32Array, rate: number, minSec: number, maxSec: number): number {
  const end = Math.min(s.length, Math.floor(maxSec * rate));
  const start = Math.floor(minSec * rate);
  const win = Math.floor(0.2 * rate);
  if (end - start < win) return end;
  let best = end;
  let quiet = Infinity;
  const step = Math.floor(win / 2);
  for (let a = start; a + win <= end; a += step) {
    const r = rms(s, a, a + win);
    // Later pauses win ties, so pieces stay long.
    if (r <= quiet) {
      quiet = r;
      best = a + Math.floor(win / 2);
    }
  }
  return best;
}

/** Samples as 16-bit little-endian PCM bytes. */
export function pcm16(s: Float32Array): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) {
    const v = Math.max(-1, Math.min(1, s[i]));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

/** A WAV file (16-bit mono PCM). */
export function wavFile(s: Float32Array, rate = SPEECH_RATE): Uint8Array {
  const data = pcm16(s);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const str = (at: number, t: string) => [...t].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** Bytes as base64 (in slices, so long audio doesn't overflow the call stack). */
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Collects 16 kHz audio and hands out pieces of `minSec`–`maxSec`, cut at pauses. Pieces that are
 * all silence are dropped (nothing to transcribe, nothing sent).
 */
export class SpeechChunker {
  private buf = new Float32Array(SPEECH_RATE * 40);
  private len = 0;
  /** Seconds of audio handed out or dropped so far (where the next piece starts). */
  at = 0;
  constructor(
    private onPiece: (samples: Float32Array, startSec: number) => void,
    private minSec = 12,
    private maxSec = 24,
    private silence = 0.006,
  ) {}

  push(samples: Float32Array) {
    if (this.len + samples.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + samples.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(samples, this.len);
    this.len += samples.length;
    while (this.len >= this.maxSec * SPEECH_RATE) this.cut(cutPoint(this.buf.subarray(0, this.len), SPEECH_RATE, this.minSec, this.maxSec));
  }

  /** The rest (at the end of a recording). */
  flush() {
    if (this.len >= 0.5 * SPEECH_RATE) this.cut(this.len);
    this.len = 0;
  }

  private cut(n: number) {
    const piece = this.buf.slice(0, n);
    const start = this.at;
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
    this.at += n / SPEECH_RATE;
    if (rms(piece) >= this.silence) this.onPiece(piece, start);
  }
}
