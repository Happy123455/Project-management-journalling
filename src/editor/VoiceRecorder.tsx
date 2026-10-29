import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { formatDuration, pickAudioType } from "../lib/capture";
import { showError } from "../lib/toast";
import { insertFiles } from "./attachments";

/** Opens the recorder; what's recorded goes in at the cursor. `kind` "sound" makes a short clip. */
export function openVoiceRecorder(editor: Editor, kind: "voice" | "sound" = "voice") {
  window.dispatchEvent(new CustomEvent("journal:voice", { detail: { editor, kind } }));
}

/** Records a voice note (or a short sound) with the microphone. */
export function VoiceRecorder() {
  const [open, setOpen] = useState<{ editor: Editor; kind: "voice" | "sound" } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const keep = useRef(true);

  useEffect(() => {
    const onOpen = (e: Event) => setOpen((e as CustomEvent<{ editor: Editor; kind: "voice" | "sound" }>).detail);
    window.addEventListener("journal:voice", onOpen);
    return () => window.removeEventListener("journal:voice", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let frame = 0;
    keep.current = true;
    setSeconds(0);
    (async () => {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = pickAudioType((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop());
        if (keep.current && chunks.length) {
          const mime = rec.mimeType.split(";")[0] || "audio/webm";
          const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
          const name = `${open.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
          void insertFiles(open.editor, [new File(chunks, name, { type: mime })]);
        }
        setOpen(null);
      };
      rec.start(1000);
      recorder.current = rec;
      const started = Date.now();
      timer = window.setInterval(() => setSeconds((Date.now() - started) / 1000), 250);
      // A simple level meter so it's clear the microphone hears you.
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        setLevel(Math.min(1, data.reduce((m, v) => Math.max(m, Math.abs(v - 128)), 0) / 64));
        frame = requestAnimationFrame(tick);
      };
      tick();
    })().catch((e) => {
      showError("The microphone couldn't start", e);
      setOpen(null);
    });
    return () => {
      window.clearInterval(timer);
      cancelAnimationFrame(frame);
      if (recorder.current?.state === "recording") {
        keep.current = false;
        recorder.current.stop();
      }
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  if (!open) return null;
  const finish = (save: boolean) => {
    keep.current = save;
    if (recorder.current?.state === "recording") recorder.current.stop();
    else setOpen(null);
  };
  return (
    <>
      <div className="search-backdrop" />
      <div className="confirm-card voice-card" role="dialog" aria-label="Recording">
        <h2>{open.kind === "sound" ? "🔊 Recording a sound" : "🎙 Recording a voice note"}</h2>
        <div className="voice-meter"><span style={{ transform: `scaleX(${0.05 + level * 0.95})` }} /></div>
        <p className="voice-time">● {formatDuration(seconds)}</p>
        <div className="confirm-actions">
          <button type="button" onClick={() => finish(false)}>Cancel</button>
          <button type="button" className="danger" onClick={() => finish(true)}>■ Stop & save</button>
        </div>
      </div>
    </>
  );
}
