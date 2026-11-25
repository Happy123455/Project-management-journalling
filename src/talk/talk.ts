// 🎤 Reflective interviewer and 📞 Gujarati call (Hapi, 22 Nov).
//
// Interview: "when I don't have motivation to write… with one click… an interviewer that asks me
// about my day with a philosophical twist… it should listen to me for a long time, then think,
// present its own view and question me again when I press Send". The local model asks (Ollama on
// the Mac; Gemini where there's none, e.g. the phone), answers are heard by Whisper, and every
// question, answer and reflection goes into today's note as soon as it exists.
//
// Call: the same turn by turn, in Gujarati: the recording goes to Gemini (it hears Gujarati far
// better than a small Whisper), which answers in Gujarati and gives English for both sides. The
// note gets the English, with the Gujarati under each line as a quiet comment.
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { askAi, localAvailable } from "../ai/client";
import { geminiText } from "../ai/decide";
import { appendBlocks } from "../lib/append";
import { dayKey, formatTimestamp } from "../lib/timestamp";
import { docText } from "../lib/words";
import { base64, wavFile } from "../lib/wav";

export type TalkMode = "interview" | "call";

export interface TalkTurn {
  /** Who spoke: the AI or you. */
  by: "ai" | "me";
  /** English (the interview is English only). */
  text: string;
  /** The Gujarati original (call). */
  gu?: string;
  /** The AI's reflection on your last answer, said before its next question. */
  reflect?: string;
}

export const INTERVIEW_ACTOR = "Interviewer";
export const CALL_ACTOR = "Gujarati call";

export const INTERVIEW_SYSTEM = `You are a warm, curious interviewer helping Hapi journal about their day by talking.
Ask ONE question at a time. Questions are about Hapi's day (what happened, what they felt, chose, avoided, learned), each with a philosophical twist: meaning, freedom, time, character, habit, desire, fear, what a good life is. Make them concrete enough to answer from today, never generic.
After each answer: first give your own honest view in 2 to 4 sentences (a reflection, a connection to an idea or thinker, or a gentle challenge where something doesn't add up), then ask the next question, going deeper into what they said or turning to another part of the day.
Plain spoken English, no lists, no headings, no flattery.`;

const INTERVIEW_SCHEMA = {
  type: "object",
  properties: {
    reflection: { type: "string", description: "Your view on the last answer (empty before the first question)." },
    question: { type: "string", description: "One next question." },
  },
  required: ["reflection", "question"],
};

/** The conversation so far, as plain lines for the model. */
export function transcriptText(turns: TalkTurn[]): string {
  return turns.map((t) => (t.by === "ai" ? `${t.reflect ? `Interviewer (view): ${t.reflect}\n` : ""}Interviewer: ${t.text}` : `Hapi: ${t.text}`)).join("\n");
}

/** A JSON answer, even when a small model wraps it in words or a code fence. */
export function looseJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** The interviewer's next turn: its view on the last answer and one question. */
export async function interviewTurn(turns: TalkTurn[], today: string, signal?: AbortSignal): Promise<TalkTurn> {
  const first = !turns.length;
  const text = [
    today.trim() ? `What Hapi wrote in today's journal so far (for context; don't quote it back):\n${today.trim().slice(-2500)}` : "Nothing is written in today's journal yet.",
    first ? "Start the interview: a short hello and the first question." : `The conversation so far:\n${transcriptText(turns).slice(-6000)}\n\nNow your view on Hapi's last answer, then the next question.`,
    'Answer as JSON: {"reflection": "...", "question": "..."}.',
  ].join("\n\n");
  // The Mac's local model (qwen3, free, nothing leaves the Mac); where there's none (the phone),
  // Gemini's quick Lite model.
  const local = await localAvailable();
  const req = local ? ({ task: "describe", provider: "local" } as const) : ({ task: "chat", provider: "gemini" } as const);
  const a = await askAi({ ...req, system: INTERVIEW_SYSTEM, text, schema: INTERVIEW_SCHEMA, maxTokens: 700, timeoutMs: local ? 240_000 : undefined }).catch(async (e) => {
    if (signal?.aborted) throw e;
    // A small model's JSON may come out loose: the same, read loosely.
    const r = await askAi({ ...req, system: INTERVIEW_SYSTEM, text, maxTokens: 700 });
    return { ...r, json: looseJson(r.text) };
  });
  const j = (a.json ?? looseJson(a.text) ?? {}) as { reflection?: string; question?: string };
  const question = (j.question || a.text).trim();
  return { by: "ai", text: question, reflect: first ? undefined : j.reflection?.trim() || undefined };
}

export const CALL_SYSTEM = `You are Hapi's friend on a phone call, talking in Gujarati (Gujarati script, everyday spoken Gujarati as in Saurashtra, English words where people would use them).
Listen to what Hapi says in the audio and reply like a friend on a call: 1 to 3 short sentences, warm and natural, and usually one follow-up question about their day or what they said.
Also give English for both: what Hapi said (faithful) and what you replied.`;

const CALL_SCHEMA = {
  type: "object",
  properties: {
    heard_gu: { type: "string", description: "What Hapi said, written in Gujarati script, word for word." },
    heard_en: { type: "string", description: "The same in English." },
    reply_gu: { type: "string", description: "Your reply in Gujarati script." },
    reply_en: { type: "string", description: "Your reply in English." },
  },
  required: ["heard_gu", "heard_en", "reply_gu", "reply_en"],
};

export const CALL_HELLO: TalkTurn = { by: "ai", gu: "નમસ્તે! કેમ છો? આજનો દિવસ કેવો રહ્યો?", text: "Hello! How are you? How was your day today?" };

/** One call turn: Hapi's recording in, both sides in Gujarati and English out. */
export async function callTurn(turns: TalkTurn[], samples: Float32Array, fetchImpl?: typeof fetch): Promise<{ heard: TalkTurn; reply: TalkTurn }> {
  const before = turns
    .slice(-12)
    .map((t) => `${t.by === "ai" ? "You" : "Hapi"}: ${t.gu ?? t.text}`)
    .join("\n");
  const { text } = await geminiText(
    ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"],
    {
      systemInstruction: { parts: [{ text: CALL_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: before ? `The call so far:\n${before}\n\nHapi now says (audio):` : "Hapi says (audio):" }, { inlineData: { mimeType: "audio/wav", data: base64(wavFile(samples)) } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: CALL_SCHEMA, temperature: 0.7, maxOutputTokens: 2048 },
    },
    fetchImpl,
    45_000,
  );
  const j = (looseJson(text) ?? {}) as Record<string, string | undefined>;
  return {
    heard: { by: "me", text: (j.heard_en ?? "").trim(), gu: (j.heard_gu ?? "").trim() },
    reply: { by: "ai", text: (j.reply_en ?? "").trim(), gu: (j.reply_gu ?? "").trim() },
  };
}

const p = (text: string, attrs?: Record<string, unknown>, italic = false): JSONContent => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  ...(text ? { content: [{ type: "text", text, ...(italic ? { marks: [{ type: "italic" }] } : {}) }] } : {}),
});

/** The note lines for some turns: the English, and the Gujarati under it as a quiet comment. */
export function turnBlocks(turns: TalkTurn[], mode: TalkMode): JSONContent[] {
  const out: JSONContent[] = [];
  for (const t of turns) {
    if (t.reflect) out.push(p(`🪞 ${t.reflect}`));
    if (t.by === "ai") out.push(p(`${mode === "call" ? "📞" : "❓"} ${t.text}`));
    else out.push(p(`💬 ${t.text}`));
    if (t.gu) out.push(p(`ગુ: ${t.gu}`, { indent: 1 }, true));
  }
  return out;
}

export const sessionHead = (mode: TalkMode, at: Date) => p(`${mode === "call" ? "📞 Gujarati call" : "🎤 Reflective interview"} · ${formatTimestamp(at)}`);

/** Adds lines to the end of a day's note (flushing the editor first, so nothing typed is lost). */
export async function appendToDay(store: JournalStore, day: string, blocks: JSONContent[], actor: string) {
  if (!blocks.length) return;
  await window.__journalFlush?.();
  const note = await store.getDay(day);
  const doc = appendBlocks(note?.content ?? null, blocks);
  await store.saveDay({ day, content: doc, plainText: docText(doc), actor });
  window.dispatchEvent(new Event("journal:reload-page"));
}

/** Today's note as text (what the interviewer may know about the day). */
export async function todayText(store: JournalStore, at = new Date()): Promise<string> {
  const note = await store.getDay(dayKey(at));
  return note?.content ? docText(note.content) : "";
}

/** Gujarati call over Gemini Live: both sides in English for the note (one quick Flash-Lite call). */
export async function translateCall(me: string, ai: string): Promise<{ me: string; ai: string }> {
  const { text } = await geminiText(
    ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.8-flash"],
    {
      contents: [{ role: "user", parts: [{ text: `Translate both into natural English, faithfully.\nHapi said: ${me || "(nothing)"}\nFriend replied: ${ai || "(nothing)"}` }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: { type: "object", properties: { me: { type: "string" }, ai: { type: "string" } }, required: ["me", "ai"] }, temperature: 0.2, maxOutputTokens: 1024 },
    },
    undefined,
    30_000,
  );
  const j = (looseJson(text) ?? {}) as Record<string, string | undefined>;
  return { me: (j.me ?? "").trim(), ai: (j.ai ?? "").trim() };
}

/** What the Live voice is told (its words come back as text, so plain sentences only). */
export function liveSystem(mode: TalkMode, today: string): string {
  if (mode === "call")
    return `${CALL_SYSTEM.split("\nAlso give English")[0]}\nSpeak only Gujarati. Keep each reply short, like a real call.`;
  return `${INTERVIEW_SYSTEM}\nYou are speaking out loud: no lists or markup. Before each question, when there was an answer, say your view first.\n\nHapi's note for today so far:\n${today.slice(0, 6000) || "(empty)"}`;
}
