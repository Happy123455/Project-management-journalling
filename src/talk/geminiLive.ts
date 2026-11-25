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
  /** Anything came back from the model (the turn is being answered). */
  onActivity?: () => void;
}

/** A function call from the model; answer it with an object (sent back as its response). */
export interface LiveCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveOptions {
  voice?: string;
  /** Function declarations (Gemini's shape) the model may call. */
  tools?: unknown[];
  /** Runs the model's calls; each answer goes back as that call's response. */
  onToolCall?: (calls: LiveCall[]) => Promise<Record<string, unknown>[]>;
  /** Play its voice (default true). Off: nothing is played and no audio output is opened. */
  play?: boolean;
  /** "TEXT" for a written answer (when the model allows it); AUDIO by default. */
  modality?: "AUDIO" | "TEXT";
  model?: string;
  /** For tests and the probe (Node's WebSocket). */
  WebSocketImpl?: typeof WebSocket;
  /** How long to wait for the setup to be accepted (ms). */
  setupMs?: number;
  /** Tokens used, per answer. */
  onUsage?: (model: string, input: number, output: number) => void;
}

/** Gemini's Schema wants upper-case type names in the Live API; the REST one takes either. */
export function liveSchema<T>(v: T): T {
  if (Array.isArray(v)) return v.map(liveSchema) as T;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = k === "type" && typeof x === "string" ? x.toUpperCase() : liveSchema(x);
  return out as T;
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
  /** A note added to the talk without asking for an answer (fresh context before a turn). */
  note(t: string): void;
  /** Stop its voice now. */
  hush(): void;
  close(): void;
  /** Still connected. */
  open(): boolean;
}

/** Opens a Live session (🎙️ Talk). Rejects if there's no key or the model doesn't answer the setup in 8 s. */
export function openLive(system: string, h: LiveHandlers, voice = "Puck"): Promise<LiveSession> {
  return openLiveWith(system, h, { voice });
}

/** A Live session with options: tools the model may call, playing its voice or not, written answers. */
export async function openLiveWith(system: string, h: LiveHandlers, o: LiveOptions = {}): Promise<LiveSession> {
  const key = await getKey("gemini");
  if (!key) throw new Error("no Gemini key");
  const WS = o.WebSocketImpl ?? WebSocket;
  const model = o.model ?? liveModel();
  const ws = new WS(`${URL_BASE}?key=${encodeURIComponent(key)}`);
  const playing = o.play !== false && typeof AudioContext !== "undefined";
  // Opened on the first sound to play (a muted agent never opens an audio output: phone audio
  // glitched with several streams open, 25 Nov).
  let ctx: AudioContext | null = null;
  const audioOut = () => (ctx ??= new AudioContext({ sampleRate: 24000 }));
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
    if (closed || !playing) return;
    const ctx = audioOut();
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
    setTimeout(() => h.onLevel?.(peak), Math.max(0, (t - ctx.currentTime) * 1000));
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
  const send = (m: unknown) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const shut = () => {
    closed = true;
    hush();
    void ctx?.close().catch(() => {});
  };
  const read = async (data: unknown) => JSON.parse(typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : typeof (data as Blob).text === "function" ? await (data as Blob).text() : String(data));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => (ws.close(), reject(new Error("Gemini Live didn't answer"))), o.setupMs ?? 8000);
    ws.onopen = () =>
      send({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: [o.modality ?? "AUDIO"],
            ...(o.modality === "TEXT" ? {} : { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice ?? "Puck" } } } }),
          },
          systemInstruction: { parts: [{ text: system }] },
          ...(o.tools?.length ? { tools: [{ functionDeclarations: liveSchema(o.tools) }] } : {}),
          inputAudioTranscription: {},
          ...(o.modality === "TEXT" ? {} : { outputAudioTranscription: {} }),
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          contextWindowCompression: { slidingWindow: {} },
        },
      });
    ws.onerror = () => (clearTimeout(timer), reject(new Error("Gemini Live couldn't connect")));
    ws.onclose = (e) => (clearTimeout(timer), reject(new Error(e.reason || `Gemini Live closed (${e.code})`)));
    ws.onmessage = async (e) => {
      const msg = await read(e.data);
      if (msg.setupComplete) {
        clearTimeout(timer);
        resolve();
        ws.onmessage = (ev) => void onMessage(ev).catch((err) => console.warn("[live]", err));
        ws.onclose = (ev) => {
          shut();
          h.onClose?.(ev.reason || `closed (${ev.code})`);
        };
      }
    };
  });

  async function onMessage(e: MessageEvent) {
    const msg = await read(e.data);
    if (msg.usageMetadata) o.onUsage?.(model, msg.usageMetadata.promptTokenCount ?? 0, msg.usageMetadata.responseTokenCount ?? msg.usageMetadata.candidatesTokenCount ?? 0);
    if (msg.goAway) console.info("[live] going away soon", msg.goAway.timeLeft);
    if (msg.toolCall?.functionCalls?.length) {
      h.onActivity?.();
      const calls: LiveCall[] = msg.toolCall.functionCalls.map((c: { id?: string; name: string; args?: Record<string, unknown> }) => ({ id: c.id ?? "", name: c.name, args: c.args ?? {} }));
      const answers = o.onToolCall ? await o.onToolCall(calls) : calls.map(() => ({ error: "no tools here" }));
      send({ toolResponse: { functionResponses: calls.map((c, i) => ({ id: c.id, name: c.name, response: answers[i] ?? {} })) } });
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) h.onHeard?.((heard += sc.inputTranscription.text));
    if (sc.outputTranscription?.text) (h.onActivity?.(), h.onSaid?.((said += sc.outputTranscription.text)));
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data && /audio/.test(p.inlineData.mimeType ?? "")) (h.onActivity?.(), play(fromBase64Pcm16(p.inlineData.data)));
      // A written answer (TEXT mode), thoughts left out.
      else if (typeof p.text === "string" && !p.thought) (h.onActivity?.(), h.onSaid?.((said += p.text)));
    }
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
    note: (t) => send({ clientContent: { turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: false } }),
    hush,
    close: () => {
      shut();
      ws.close();
    },
    open: () => !closed && ws.readyState === 1,
  };
}
