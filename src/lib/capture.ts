/** Recording formats in order of preference: MP4 plays everywhere (including the Mac), WebM is the fallback. */
const RECORDER_TYPES = ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

/** The first recording format this device supports, or "" to let the browser choose. */
export function pickRecorderType(isSupported: (type: string) => boolean): string {
  return RECORDER_TYPES.find((t) => isSupported(t)) ?? "";
}

/** Audio recording formats in order of preference (AAC in MP4 plays everywhere). */
const AUDIO_TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export function pickAudioType(isSupported: (type: string) => boolean): string {
  return AUDIO_TYPES.find((t) => isSupported(t)) ?? "";
}

/** "0:07", "12:45". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How a scanned QR code goes into the page: links become tappable links, anything else plain text. */
export function qrContent(raw: string): { text: string; href: string | null } {
  const text = raw.trim();
  return { text, href: /^https?:\/\/\S+$/i.test(text) ? text : null };
}
