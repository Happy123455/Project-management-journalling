/** Recording formats in order of preference: MP4 plays everywhere (including the Mac), WebM is the fallback. */
const RECORDER_TYPES = ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

/** The first recording format this device supports, or "" to let the browser choose. */
export function pickRecorderType(isSupported: (type: string) => boolean): string {
  return RECORDER_TYPES.find((t) => isSupported(t)) ?? "";
}

/** How a scanned QR code goes into the page: links become tappable links, anything else plain text. */
export function qrContent(raw: string): { text: string; href: string | null } {
  const text = raw.trim();
  return { text, href: /^https?:\/\/\S+$/i.test(text) ? text : null };
}
