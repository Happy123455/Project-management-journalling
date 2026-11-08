/**
 * Paradee (Sahil Mahendrakar, Apache-2.0): an 8M-parameter English voice distilled from Kokoro-82M,
 * one 9 MB int8 ONNX file, many times faster than real time on one CPU thread. It runs right in the
 * app's web view (onnxruntime-web, no native code), the same on the Mac and the phone.
 * Text → eSpeak NG phonemes (phonemizer, as kokoro-js does) → misaki's spelling (Paradee only
 * learned misaki's; raw eSpeak makes it mumble) → Kokoro token ids → 24 kHz audio.
 * The model is downloaded once from Hugging Face and kept in IndexedDB.
 */

// The wasm runtime ships with the app (only fetched when Paradee first speaks), so it works offline.
import ortWasm from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";

export const PARADEE_URL = "https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0/resolve/main/onnx/paradee_int8.onnx";
export const PARADEE_SIZE_MB = 9;
export const SAMPLE_RATE = 24_000;
const MAX_TOKENS = 510;

// config.json "vocab" of Paradee-8M-v1.0 (Kokoro's).
const VOCAB: Record<string, number> = Object.fromEntries(
  [
    [";", 1], [":", 2], [",", 3], [".", 4], ["!", 5], ["?", 6], ["—", 9], ["…", 10], ['"', 11], ["(", 12], [")", 13], ["“", 14], ["”", 15], [" ", 16],
    ["̃", 17], ["ʣ", 18], ["ʥ", 19], ["ʦ", 20], ["ʨ", 21], ["ᵝ", 22], ["ꭧ", 23], ["A", 24], ["I", 25], ["O", 31], ["Q", 33], ["S", 35], ["T", 36],
    ["W", 39], ["Y", 41], ["ᵊ", 42], ["a", 43], ["b", 44], ["c", 45], ["d", 46], ["e", 47], ["f", 48], ["h", 50], ["i", 51], ["j", 52], ["k", 53],
    ["l", 54], ["m", 55], ["n", 56], ["o", 57], ["p", 58], ["q", 59], ["r", 60], ["s", 61], ["t", 62], ["u", 63], ["v", 64], ["w", 65], ["x", 66],
    ["y", 67], ["z", 68], ["ɑ", 69], ["ɐ", 70], ["ɒ", 71], ["æ", 72], ["β", 75], ["ɔ", 76], ["ɕ", 77], ["ç", 78], ["ɖ", 80], ["ð", 81], ["ʤ", 82],
    ["ə", 83], ["ɚ", 85], ["ɛ", 86], ["ɜ", 87], ["ɟ", 90], ["ɡ", 92], ["ɥ", 99], ["ɨ", 101], ["ɪ", 102], ["ʝ", 103], ["ɯ", 110], ["ɰ", 111],
    ["ŋ", 112], ["ɳ", 113], ["ɲ", 114], ["ɴ", 115], ["ø", 116], ["ɸ", 118], ["θ", 119], ["œ", 120], ["ɹ", 123], ["ɾ", 125], ["ɻ", 126], ["ʁ", 128],
    ["ɽ", 129], ["ʂ", 130], ["ʃ", 131], ["ʈ", 132], ["ʧ", 133], ["ʊ", 135], ["ʋ", 136], ["ʌ", 138], ["ɣ", 139], ["ɤ", 140], ["χ", 142], ["ʎ", 143],
    ["ʒ", 147], ["ʔ", 148], ["ˈ", 156], ["ˌ", 157], ["ː", 158], ["ʰ", 162], ["ʲ", 164], ["↓", 169], ["→", 171], ["↗", 172], ["↘", 173], ["ᵻ", 177],
  ] as [string, number][],
);

// misaki's eSpeak-to-misaki table (paradee web/misaki.js, Apache-2.0), American English.
const E2M: [string, string][] = [
  ["ʔˌn̩", "ʔn"], ["ʔn̩", "ʔn"], ["aɪ", "I"], ["aʊ", "W"], ["dʒ", "ʤ"], ["eɪ", "A"], ["e", "A"], ["tʃ", "ʧ"], ["ɔɪ", "Y"],
  ["ʲo", "jo"], ["ʲə", "jə"], ["ʲ", ""], ["ɚ", "əɹ"], ["r", "ɹ"], ["x", "k"], ["ç", "k"], ["ɬ", "l"], ["̃", ""],
];
const END = "[\\s;:,.!?—…\"“”()]";

/** eSpeak NG phonemes in misaki's spelling (what Paradee learned). */
export function toMisaki(ps: string): string {
  for (const [a, b] of E2M) ps = ps.split(a).join(b);
  ps = ps.replace(/(\S)̩/gu, "ᵊ$1").replace(/̩/g, "");
  ps = ps.replace(new RegExp(`əl(?=${END}|$)`, "gu"), "ᵊl");
  ps = ps.replace(new RegExp(`ɐ(?!${END}|$)`, "gu"), "ə");
  ps = ps.split("oʊ").join("O").split("ɜːɹ").join("ɜɹ").split("ɜː").join("ɜɹ").split("ɪə").join("iə").split("ː").join("");
  ps = ps.split("o").join("ɔ");
  return ps.split("ɾ").join("T").split("ʔ").join("t");
}

/** Phoneme text → model ids, padded with 0 at both ends. Characters the model doesn't know are skipped. */
export function tokenize(ps: string): number[] {
  const ids = [...ps].map((c) => VOCAB[c]).filter((n): n is number => n !== undefined);
  return [0, ...ids.slice(0, MAX_TOKENS), 0];
}

const PUNCT = /([;:,.!?—…"“”()]+)/;

/** A sentence's phonemes, punctuation kept (eSpeak drops it, but it shapes Paradee's pauses). */
export async function phonemes(text: string): Promise<string> {
  const { phonemize } = await import("phonemizer");
  const clean = text.replace(/[‘’]/g, "'").replace(/\s+/g, " ").replace(/[–]/g, "—").replace(/\.\.\./g, "…").trim();
  const out: string[] = [];
  for (const piece of clean.split(PUNCT)) {
    if (!piece.trim()) continue;
    if (/^[;:,.!?—…"“”()]+$/.test(piece)) {
      out.push(piece);
      continue;
    }
    const ps = (await phonemize(piece, "en-us")).join(" ");
    if (ps.trim()) out.push((out.length ? " " : "") + ps.trim());
  }
  return toMisaki(out.join("").trim());
}

/** Sentences with where each starts in the text (for following along while reading). */
export function sentences(text: string): [number, string][] {
  const out: [number, string][] = [];
  const re = /[^.!?…\n]+[.!?…]*["”)]*\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (!s) continue;
    // Long sentences go in pieces at commas so one call stays under the model's limit.
    if (s.length <= 300) out.push([m.index, s]);
    else {
      let at = m.index;
      for (const part of s.split(/(?<=[,;:])\s+/)) {
        out.push([at, part]);
        at += part.length + 1;
      }
    }
  }
  return out;
}

// --- Model storage (IndexedDB) and session ---

const DB = "journal-voices";
function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("models");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function stored(): Promise<ArrayBuffer | null> {
  const db = await idb();
  return new Promise((ok) => {
    const r = db.transaction("models").objectStore("models").get("paradee");
    r.onsuccess = () => ok((r.result as ArrayBuffer) ?? null);
    r.onerror = () => ok(null);
  });
}
async function store(bytes: ArrayBuffer | null) {
  const db = await idb();
  await new Promise<void>((ok, fail) => {
    const tx = db.transaction("models", "readwrite");
    if (bytes) tx.objectStore("models").put(bytes, "paradee");
    else tx.objectStore("models").delete("paradee");
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
  });
}

export async function paradeeInstalled(): Promise<boolean> {
  try {
    return !!(await stored());
  } catch {
    return false;
  }
}

/** Downloads the 9 MB model once; `progress` gets (received, total) bytes. */
export async function downloadParadee(progress: (received: number, total: number) => void): Promise<void> {
  const res = await fetch(PARADEE_URL);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || PARADEE_SIZE_MB * 1_000_000;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    progress(received, total);
  }
  const all = new Uint8Array(received);
  let at = 0;
  for (const p of parts) (all.set(p, at), (at += p.length));
  await store(all.buffer);
}

export async function removeParadee() {
  session = null;
  await store(null);
}

type Ort = typeof import("onnxruntime-web");
let session: Promise<{ ort: Ort; s: import("onnxruntime-web").InferenceSession }> | null = null;
function load() {
  session ??= (async () => {
    const bytes = await stored();
    if (!bytes) throw new Error("The Paradee voice isn't downloaded");
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = { wasm: ortWasm };
    ort.env.wasm.numThreads = 1;
    const s = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ["wasm"] });
    return { ort: ort as unknown as Ort, s };
  })();
  session.catch(() => (session = null));
  return session;
}

/** One sentence as 24 kHz samples. */
export async function synthesize(text: string, speed = 1): Promise<Float32Array> {
  const { ort, s } = await load();
  return synthesizeWith(ort, s, text, speed);
}

/** The same with a given runtime and session (tests run the model file in node). */
export async function synthesizeWith(ort: Ort, s: import("onnxruntime-web").InferenceSession, text: string, speed = 1): Promise<Float32Array> {
  const ids = tokenize(await phonemes(text));
  if (ids.length <= 2) return new Float32Array(0);
  const out = await s.run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    speed: new ort.Tensor("float32", Float32Array.from([speed]), [1]),
  });
  return (out.waveform ?? Object.values(out)[0]).data as Float32Array;
}

// --- Playback ---

let playing: { ctx: AudioContext; stop: boolean } | null = null;

/**
 * Reads `text` aloud sentence by sentence (the next one is made while the current one plays).
 * `onRange` gets the character index of each sentence as it starts. Resolves when done or stopped.
 */
export async function paradeeSpeak(text: string, rate: number, onRange: (i: number) => void): Promise<void> {
  paradeeStop();
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  void ctx.resume().catch(() => {});
  const me = { ctx, stop: false };
  playing = me;
  const list = sentences(text);
  let next = list.length ? synthesize(list[0][1], rate) : null;
  for (let i = 0; i < list.length && !me.stop; i++) {
    const samples = await next!;
    next = i + 1 < list.length ? synthesize(list[i + 1][1], rate) : null;
    if (me.stop) break;
    if (!samples.length) continue;
    onRange(list[i][0]);
    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    await new Promise<void>((ok) => {
      src.onended = () => ok();
      src.start();
      const poll = window.setInterval(() => me.stop && (window.clearInterval(poll), src.stop(), ok()), 100);
      src.addEventListener("ended", () => window.clearInterval(poll));
    });
  }
  void ctx.close();
  if (playing === me) playing = null;
}

export function paradeeStop() {
  if (!playing) return;
  playing.stop = true;
  playing = null;
}
