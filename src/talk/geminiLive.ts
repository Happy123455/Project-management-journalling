// 🎙️ Gemini Live (Hapi, 25 Nov: "use Gemini Live… make the most of it"). One WebSocket to the Live
// API: your voice goes up as 16 kHz PCM while you hold the turn, its voice comes back as 24 kHz PCM
// and plays at once, and both sides come back written down too (input/output transcription).
//
// Turn taking stays Hapi's: automatic voice detection is OFF, so it never cuts in while you pause
// to think. You talk; Send ends your turn (activityEnd) and only then does it answer.
import { getKey } from "../ai/secrets";
import { base64 } from "../lib/wav";

/** Model ids from ai.google.dev/gemini-api/docs/models (checked 25 Nov 2026). Override: localStorage journal.liveVoiceModel. */
export const LIVE_MODELS = ["gemini-3.8-live", "gemini-3.8-live-extended-thinking"];
const URL_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export function liveModel(): string {
  try {
    return localStorage.getItem("journal.liveVoiceModel") || LIVE_MODELS[0];
  } catch {
    return LIVE_MODELS[0];
  }
}

export interface LiveHandlers {
  /** Words you said so far this turn (grows). */
  onHeard?: (text: string) => void;
  /** Words it has said so far this turn (grows). */
  onSaid?: (text: string) => void;
  /** It finished answering: the whole turn, both sides. */
  onTurn?: (me: string, ai: string) => void;
  /** Its voice level 0..1 (for the wave). */
  onLevel?: (level: number) => void;
  onSpeaking?: (on: boolean) => void;
  onClose?: (why: string) => void;
}

/** Float32 [-1,1] → little-endian PCM16 bytes. */
export function toPcm16(s: Float32Array): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) v.setInt16(i * 2, Math.max(-1, Math.min(1, s[i])) * 0x7fff, true);
  return out;
}

function fromBase64Pcm16(b64: string): Float32Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (x & 0x8000) x -= 0x10000;
    out[i] = x / 0x8000;
  }
  return out;
}

export interface LiveSession {
  /** Your turn starts (call before sending audio). */
  begin(): void;
  /** 16 kHz mono samples of your voice. */
  audio(s: Float32Array): void;
  /** Your turn is done: it answers now. */
  done(): void;
  /** A text message as your turn (e.g. "start"). */
  text(t: string): void;
  /** Stop its voice now. */
  hush(): void;
  close(): void;
}

/** Opens a Live session. Rejects if there's no key or the model doesn't answer the setup in 8 s. */
export async function openLive(system: string, h: LiveHandlers, voice = "Puck"): Promise<LiveSession> {
  const key = await getKey("gemini");
  if (!key) throw new Error("no Gemini key");
  const ws = new WebSocket(`${URL_BASE}?key=${encodeURIComponent(key)}`);
  const ctx = new AudioContext({ sampleRate: 24000 });
  let playAt = 0;
  const sources = new Set<AudioBufferSourceNode>();
  let heard = "";
  let said = "";
  let speaking = false;
  let closed = false;
  const setSpeaking = (on: boolean) => {
    if (on !== speaking) (speaking = on), h.onSpeaking?.(on);
  };
  const play = (pcm: Float32Array) => {
    if (closed) return;
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t = Math.max(ctx.currentTime + 0.03, playAt);
    src.start(t);
    playAt = t + buf.duration;
    sources.add(src);
    setSpeaking(true);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
    window.setTimeout(() => h.onLevel?.(peak), Math.max(0, (t - ctx.currentTime) * 1000));
    src.onended = () => {
      sources.delete(src);
      if (!sources.size) (setSpeaking(false), h.onLevel?.(0));
    };
  };
  const hush = () => {
    for (const s of sources) s.stop();
    sources.clear();
    playAt = 0;
    setSpeaking(false);
  };
  const send = (o: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => (ws.close(), reject(new Error("Gemini Live didn't answer"))), 8000);
    ws.onopen = () =>
      send({
        setup: {
          model: `models/${liveModel()}`,
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
          systemInstruction: { parts: [{ text: system }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
      });
    ws.onerror = () => (window.clearTimeout(timer), reject(new Error("Gemini Live couldn't connect")));
    ws.onclose = (e) => (window.clearTimeout(timer), reject(new Error(e.reason || `Gemini Live closed (${e.code})`)));
    ws.onmessage = async (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : await (e.data as Blob).text());
      if (msg.setupComplete) {
        window.clearTimeout(timer);
        resolve();
        ws.onmessage = (ev) => void onMessage(ev);
        ws.onclose = (ev) => {
          closed = true;
          hush();
          void ctx.close().catch(() => {});
          h.onClose?.(ev.reason || `closed (${ev.code})`);
        };
      }
    };
  });

  async function onMessage(e: MessageEvent) {
    const msg = JSON.parse(typeof e.data === "string" ? e.data : await (e.data as Blob).text());
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) h.onHeard?.((heard += sc.inputTranscription.text));
    if (sc.outputTranscription?.text) h.onSaid?.((said += sc.outputTranscription.text));
    for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data && /audio/.test(p.inlineData.mimeType ?? "")) play(fromBase64Pcm16(p.inlineData.data));
    if (sc.interrupted) hush();
    if (sc.turnComplete) {
      h.onTurn?.(heard.trim(), said.trim());
      heard = "";
      said = "";
    }
  }

  return {
    begin: () => (hush(), send({ realtimeInput: { activityStart: {} } })),
    audio: (s) => send({ realtimeInput: { audio: { data: base64(toPcm16(s)), mimeType: "audio/pcm;rate=16000" } } }),
    done: () => send({ realtimeInput: { activityEnd: {} } }),
    text: (t) => send({ clientContent: { turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true } }),
    hush,
    close: () => {
      closed = true;
      hush();
      ws.close();
      void ctx.close().catch(() => {});
    },
  };
}
