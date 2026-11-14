import { describe, expect, it } from "vitest";
import { phonemes, sentences, tokenize, toMisaki } from "./paradee";

describe("Paradee text to tokens", () => {
  it("spells eSpeak phonemes the way misaki does", () => {
    expect(toMisaki("həlˈoʊ wˈɜːld")).toBe("həlˈO wˈɜɹld");
    expect(toMisaki("dʒˈɜːnəl")).toBe("ʤˈɜɹnᵊl");
    expect(toMisaki("nˈaɪn")).toBe("nˈIn");
  });
  it("keeps punctuation and maps to ids padded with 0", async () => {
    const ps = await phonemes("Hello, world.");
    expect(ps).toBe("həlˈO, wˈɜɹld.");
    const ids = tokenize(ps);
    expect(ids[0]).toBe(0);
    expect(ids[ids.length - 1]).toBe(0);
    expect(ids).toContain(3); // ","
    expect(ids.length).toBe([...ps].length + 2);
  });
  it("splits text into sentences with their places", () => {
    expect(sentences("One two. Three!\nFour")).toEqual([[0, "One two."], [9, "Three!"], [16, "Four"]]);
  });
});

// With PARADEE_MODEL=/path/to/paradee_int8.onnx (and WAV_OUT=/path/hello.wav), runs the real model.
const model = process.env.PARADEE_MODEL;
describe.skipIf(!model)("Paradee model", () => {
  it("speaks a sentence", async () => {
    const fs = await import("node:fs");
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(model!)));
    expect([...s.inputNames].sort()).toEqual(["input_ids", "speed"]);
    const { synthesizeWith, SAMPLE_RATE } = await import("./paradee");
    const t = Date.now();
    const audio = await synthesizeWith(ort as never, s, "Hi Hapi. This is how your journal sounds when Paradee reads it aloud.");
    const secs = audio.length / SAMPLE_RATE;
    console.log(`audio ${secs.toFixed(2)} s in ${Date.now() - t} ms, peak ${Math.max(...audio.map(Math.abs)).toFixed(3)}`);
    expect(secs).toBeGreaterThan(2);
    if (process.env.WAV_OUT) {
      const pcm = Buffer.alloc(audio.length * 2);
      audio.forEach((v, i) => pcm.writeInt16LE(Math.max(-1, Math.min(1, v)) * 32767, i * 2));
      const h = Buffer.alloc(44);
      h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
      fs.writeFileSync(process.env.WAV_OUT, Buffer.concat([h, pcm]));
    }
  }, 60_000);
});
