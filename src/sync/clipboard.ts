import { receiveDrop } from "./drop";
import type { Clip } from "./direct";
import { showToast } from "../lib/toast";

/**
 * Shared clipboard over the Wi-Fi link (direct.ts): what's copied on one device lands on the
 * other one's clipboard while both apps are open and linked.
 * - Mac: the clipboard is looked at every second while the phone is linked (text), and an image
 *   every couple of seconds when there's no text.
 * - Phone: Android only lets the app on screen read the clipboard, and says so with a notice each
 *   time, so it is read only when something was copied in the app, or when the app comes back to
 *   the screen and the clipboard changed meanwhile (checked without reading it).
 * A clip that arrives goes straight onto this device's clipboard (never sent back), and a small
 * notice says what came.
 */

const PREF = "journal.sharedClipboard";
/** Images bigger than this stay where they are. */
const MAX_IMAGE = 15 * 1024 * 1024;

// window.JournalClipboard (MainActivity.kt) is declared in editor/SmartPaste.tsx.

export function clipShareOn(): boolean {
  try {
    return localStorage.getItem(PREF) !== "off";
  } catch {
    return true;
  }
}
export function setClipShare(on: boolean) {
  try {
    localStorage.setItem(PREF, on ? "on" : "off");
  } catch {
    // Blocked storage: stays on for this run.
  }
}

let sink: ((c: Clip) => void) | null = null;
let me = "";
let other = "your other device";
/** What this device's clipboard held when last looked at (or was last given), so it goes once. */
let lastKey: string | null = null;
let lastStamp: number | null = null;

/** Set by the sync while the Wi-Fi link is up; null otherwise. */
export function setClipSink(device: string, send: ((c: Clip) => void) | null, otherName?: string) {
  me = device;
  sink = send;
  if (otherName) other = otherName;
  // Linking: what was already on the clipboard stays here, except something copied on the phone
  // just before (copied in another app, then the journal opened).
  if (send) window.setTimeout(() => void checkNow(false, true), 600);
}

/**
 * Wait (up to `ms`) for the Wi-Fi link. The phone drops the link while it's in the background, so
 * coming back from the photo picker the link is down for a second or two: sending then has to wait.
 */
export function waitForSink(ms: number): Promise<boolean> {
  if (sink) return Promise.resolve(true);
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const t = window.setInterval(() => {
      if (sink || Date.now() > until) (window.clearInterval(t), resolve(!!sink));
    }, 250);
  });
}

/** A short, stable fingerprint of a string (not for security: only "is it the same clip?"). */
function hashText(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2654435761);
  }
  return `${s.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}
export const textKey = (text: string) => `t:${hashText(text)}`;

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const isAndroid = () => /Android/i.test(navigator.userAgent);
const inApp = () => "__TAURI_INTERNALS__" in window;

/** A preview of a clip for the notice. */
export function clipPreview(text: string, max = 48): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Nexus › Send: straight to the other device while linked (whatever the clipboard setting). */
export function sendDrop(c: Omit<Clip, "id" | "from" | "at">): Clip | null {
  if (!sink) return null;
  const clip = { ...c, drop: true, id: newId(), from: me, at: Date.now() };
  sink(clip);
  return clip;
}

function send(c: Omit<Clip, "id" | "from" | "at">) {
  if (!sink || !clipShareOn()) return;
  sink({ ...c, id: newId(), from: me, at: Date.now() });
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Phone: the clipboard's stamp, without reading it. */
function phoneStamp(): { t: number; mimes: string[] } | null {
  try {
    const raw = window.JournalClipboard?.stamp?.();
    return raw ? (JSON.parse(raw) as { t: number; mimes: string[] }) : null;
  } catch {
    return null;
  }
}

/** Phone: read the clipboard (it's on screen) and send it if it's new. */
async function checkPhone(force = false, seed = false) {
  const st = phoneStamp();
  if (seed && st && Date.now() - st.t > 2 * 60_000) return void (lastStamp = st.t);
  // Unchanged since last look: nothing to read (and no notice from Android).
  if (st && !force && st.t && st.t === lastStamp) return;
  const image = st?.mimes.some((m) => m.startsWith("image/"));
  if (image) {
    const raw = window.JournalClipboard?.media();
    if (!raw) return;
    const { mime, data } = JSON.parse(raw) as { mime: string; data: string };
    if (!mime.startsWith("image/") || data.length * 0.75 > MAX_IMAGE) return;
    const key = `i:${hashText(data)}`;
    if (st) lastStamp = st.t;
    if (key === lastKey) return;
    lastKey = key;
    send({ mime, data });
    return;
  }
  const raw = window.JournalClipboard?.text?.();
  if (!raw) return;
  const { focused, text } = JSON.parse(raw) as { focused: boolean; text: string | null };
  if (!focused) return; // Android hasn't given the window focus yet: looked at again on focus
  if (st) lastStamp = st.t;
  if (!text) return;
  const key = textKey(text);
  if (key === lastKey) return;
  lastKey = key;
  send({ text });
}

let imageAt = 0;
/** Mac: read the clipboard and send it if it's new. */
/** macOS's count of copies when the clipboard was last read (null: not known, read every time). */
let macCount: number | null = null;
async function macChangeCount(): Promise<number | null> {
  try {
    const n = await (await import("@tauri-apps/api/core")).invoke<number>("clipboard_changes");
    return n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function checkMac(seed = false) {
  // Nothing copied since the last look: nothing to read (the clipboard was read every second, and
  // a picture on it decoded every 2.5 s, as long as the link was up).
  const count = await macChangeCount();
  if (count !== null && count === macCount && !seed) return;
  macCount = count;
  const { readText, readImage } = await import("@tauri-apps/plugin-clipboard-manager");
  let text = "";
  try {
    text = (await readText()) ?? "";
  } catch {
    text = "";
  }
  if (text) {
    const key = textKey(text);
    if (key === lastKey) return;
    lastKey = key;
    if (!seed) send({ text });
    return;
  }
  // No text: maybe an image (a screenshot, "Copy image"). Looked at less often, it's heavier
  // (without the change count; with it, only once per copy).
  if (count === null && Date.now() - imageAt < 2500 && !seed) return;
  imageAt = Date.now();
  try {
    const image = await readImage();
    const { width, height } = await image.size();
    if (!width || !height || width * height > 16_000_000) return;
    const rgba = await image.rgba();
    // A fingerprint from a sample of the pixels: enough to tell two clips apart.
    let sample = "";
    const step = Math.max(4, Math.floor(rgba.length / 4096) * 4);
    for (let i = 0; i < rgba.length; i += step) sample += String.fromCharCode(rgba[i], rgba[i + 1], rgba[i + 2]);
    const key = `m:${width}x${height}:${hashText(sample)}`;
    if (lastKey === "given-image") lastKey = key; // the image that just came from the phone
    if (key === lastKey) return;
    lastKey = key;
    if (seed) return;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob || blob.size > MAX_IMAGE) return;
    send({ mime: "image/png", data: toBase64(new Uint8Array(await blob.arrayBuffer())) });
  } catch {
    // Nothing on the clipboard, or not an image.
  }
}

let checking = false;
/** Looks at this device's clipboard now and sends what's new. */
export async function checkNow(force = false, seed = false) {
  if (!sink || !clipShareOn() || checking || !inApp()) return;
  checking = true;
  try {
    if (isAndroid()) await checkPhone(force, seed);
    else await checkMac(seed);
  } catch {
    // Unreadable clipboard: next time.
  } finally {
    checking = false;
  }
}

/** A clip from the other device: onto this device's clipboard. */
export async function receiveClip(c: Clip) {
  if (c.drop) return void (c.from !== me && receiveDrop(c, other));
  if (!clipShareOn() || (me && c.from === me) || !inApp()) return;
  await copyClip(c, `from ${other}`);
}

/** Puts a clip (text or image) on this device's clipboard, with a notice. */
export async function copyClip(c: Clip, where = "") {
  if (!inApp()) {
    if (c.text != null) await navigator.clipboard.writeText(c.text).catch(() => {});
    return showToast("📋 Copied");
  }
  try {
    if (c.text != null) {
      lastKey = textKey(c.text);
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(c.text);
      showToast(`📋 Copied${where ? ` ${where}` : ""}: “${clipPreview(c.text)}”`);
    } else if (c.data && c.mime?.startsWith("image/")) {
      if (isAndroid()) {
        lastKey = `i:${hashText(c.data)}`;
        if (!window.JournalClipboard?.setImage?.(c.mime, c.data)) throw new Error("not taken");
      } else {
        const bytes = Uint8Array.from(atob(c.data), (ch) => ch.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: c.mime }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas");
        ctx.drawImage(bitmap, 0, 0);
        const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const [{ Image }, { writeImage }] = await Promise.all([import("@tauri-apps/api/image"), import("@tauri-apps/plugin-clipboard-manager")]);
        lastKey = "given-image";
        await writeImage(await Image.new(new Uint8Array(rgba.buffer), bitmap.width, bitmap.height));
      }
      showToast(`📋 Image copied${where ? ` ${where}` : ""}`);
    }
    // What we just put there isn't sent back.
    if (isAndroid()) window.setTimeout(() => (lastStamp = phoneStamp()?.t ?? lastStamp), 400);
  } catch {
    showToast("📋 That couldn't be put on this clipboard", "error");
  }
}

let watching = false;
/** Starts looking at the clipboard (once per app run). */
export function startClipWatch() {
  if (watching || !inApp()) return;
  watching = true;
  if (isAndroid()) {
    // Copied in the app: send it right away.
    const onCopy = () => window.setTimeout(() => void checkNow(true), 120);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    // Back on screen: something may have been copied in another app meanwhile.
    window.addEventListener("focus", () => window.setTimeout(() => void checkNow(), 350));
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && window.setTimeout(() => void checkNow(), 900));
  } else {
    // Mac: the clipboard has no "changed" event; a quick look each second while linked.
    window.setInterval(() => sink && void checkNow(), 1000);
  }
}
