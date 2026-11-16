// The phone's gallery for the assistant ("add my latest photo"). Android only: MainActivity's
// PhotosBridge answers through window.__journalPhotos(id, json). Access is asked the first time.

declare global {
  interface Window {
    JournalPhotos?: {
      granted(): boolean;
      recent(id: string, limit: number): void;
      read(id: string, uri: string): void;
    };
    __journalPhotos?: (id: string, json: string) => void;
  }
}

export interface GalleryItem {
  uri: string;
  name: string;
  mime: string;
  size: number;
  /** When it was added to the phone (ms). */
  taken: number;
}

const waiting = new Map<string, (json: string) => void>();
let seq = 0;

function ask(call: (id: string) => void, timeoutMs: number): Promise<Record<string, unknown>> {
  window.__journalPhotos ??= (id, json) => {
    const done = waiting.get(id);
    waiting.delete(id);
    done?.(json);
  };
  return new Promise((resolve) => {
    const id = `p${Date.now()}-${seq++}`;
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      resolve({ error: "the phone didn't answer" });
    }, timeoutMs);
    waiting.set(id, (json) => {
      window.clearTimeout(timer);
      try {
        resolve(JSON.parse(json));
      } catch {
        resolve({ error: "bad answer from the phone" });
      }
    });
    try {
      call(id);
    } catch (e) {
      waiting.delete(id);
      window.clearTimeout(timer);
      resolve({ error: String(e) });
    }
  });
}

export const hasGallery = () => !!window.JournalPhotos;

/** Newest photos and videos on the phone, or a reason they can't be read. */
export async function recentGallery(limit = 30): Promise<GalleryItem[] | string> {
  const bridge = window.JournalPhotos;
  if (!bridge) return "The phone's gallery can only be read in the app on the phone.";
  // The first time, the person answers Android's permission sheet: give them time.
  const r = await ask((id) => bridge.recent(id, limit), 120_000);
  if (r.denied) return "No access to the phone's photos (allow Photos and videos for Dynamic Journal in Android settings).";
  if (typeof r.error === "string") return `Couldn't read the gallery: ${r.error}`;
  return Array.isArray(r.items) ? (r.items as GalleryItem[]) : [];
}

/** One gallery item as a File, or a reason it can't be read. */
export async function readGallery(item: GalleryItem): Promise<File | string> {
  const bridge = window.JournalPhotos;
  if (!bridge) return "No gallery here.";
  const r = await ask((id) => bridge.read(id, item.uri), 60_000);
  if (typeof r.error === "string" || typeof r.data !== "string") return `Couldn't read ${item.name}: ${String(r.error ?? "no data")}`;
  const bin = atob(r.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], item.name, { type: String(r.mime || item.mime) });
}
