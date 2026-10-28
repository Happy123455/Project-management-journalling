import { useEffect, useRef, useState } from "react";
import { pickRecorderType } from "../lib/capture";

/** What the camera screen hands back to the page. */
export type CaptureResult = { kind: "file"; file: File } | { kind: "qr"; text: string };

declare class BarcodeDetector {
  constructor(options: { formats: string[] });
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

const SCAN_EVERY_MS = 400;

/**
 * One camera screen for photos and videos. While it's open it also looks for QR codes and,
 * when it sees one, offers to insert it.
 */
export function Capture({ onDone, onClose }: { onDone: (result: CaptureResult) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [mode, setMode] = useState<"photo" | "video">("photo");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [recording, setRecording] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Start (or switch) the camera. Sound is asked for only so videos have it.
  useEffect(() => {
    let live = true;
    (async () => {
      const constraints = { video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } } };
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ ...constraints, audio: true });
      } catch {
        s = await navigator.mediaDevices.getUserMedia(constraints);
      }
      if (!live) return s.getTracks().forEach((t) => t.stop());
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => {});
      }
    })().catch(() => setError("The camera couldn't start. Allow camera access for Dynamic Journal in Settings."));
    return () => {
      live = false;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [facing]);

  // Look for QR codes in the live picture.
  useEffect(() => {
    if (!("BarcodeDetector" in window)) return;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    let busy = false;
    const timer = window.setInterval(async () => {
      const v = video.current;
      if (busy || !v || v.readyState < 2) return;
      busy = true;
      try {
        const [code] = await detector.detect(v);
        if (code?.rawValue) setQr(code.rawValue);
      } catch {
        // A frame that can't be read; try the next one.
      }
      busy = false;
    }, SCAN_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  const takePhoto = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => blob && onDone({ kind: "file", file: new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }) }),
      "image/jpeg",
      0.9,
    );
  };

  const toggleRecording = () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    if (!stream.current) return;
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      setRecording(false);
      const mime = rec.mimeType.split(";")[0] || "video/webm";
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      onDone({ kind: "file", file: new File(chunks, `video-${Date.now()}.${ext}`, { type: mime }) });
    };
    rec.start(1000);
    recorder.current = rec;
    setRecording(true);
  };

  const shutter = mode === "photo" ? takePhoto : toggleRecording;

  return (
    <div className="capture" role="dialog" aria-label="Camera">
      <video ref={video} className="capture-preview" playsInline muted />
      {error && <p className="capture-error">{error}</p>}

      <button type="button" className="capture-close" onClick={onClose} aria-label="Close camera">✕</button>
      <button
        type="button"
        className="capture-flip"
        onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
        aria-label="Switch camera"
        disabled={recording}
      >
        ⟲
      </button>

      {qr && (
        <div className="capture-qr">
          <span className="capture-qr-text">🔳 {qr}</span>
          <button type="button" onClick={() => onDone({ kind: "qr", text: qr })}>Insert</button>
          <button type="button" className="capture-qr-dismiss" onClick={() => setQr(null)} aria-label="Ignore code">✕</button>
        </div>
      )}

      <div className="capture-controls">
        <div className="capture-modes" role="tablist">
          {(["photo", "video"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "active" : ""}
              disabled={recording}
              onClick={() => setMode(m)}
            >
              {m === "photo" ? "Photo" : "Video"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`capture-shutter ${mode}${recording ? " recording" : ""}`}
          onClick={shutter}
          aria-label={mode === "photo" ? "Take photo" : recording ? "Stop recording" : "Start recording"}
        />
      </div>
    </div>
  );
}
