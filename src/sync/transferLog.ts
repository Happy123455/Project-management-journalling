/**
 * Network history: what went across, over the Wi-Fi link or Google Drive, kept on this device
 * (localStorage journal.transferLog, newest first, the last 80 entries). Small Wi-Fi requests in the
 * same minute and direction add up into one entry, so live typing doesn't flood the list.
 */
export type Via = "wifi" | "drive";
export interface Transfer {
  at: number;
  via: Via;
  up: number;
  down: number;
  /** What moved, e.g. "3 edits, 1 photo". */
  what: string;
  n: number;
}
const KEY = "journal.transferLog";
const MAX = 80;
export const TRANSFER_EVENT = "journal:transfer";

export function transfers(): Transfer[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let saveTimer: number | undefined;
let pending: Transfer[] | null = null;
function save(list: Transfer[]) {
  pending = list;
  // Written at most once a second (live typing sends many small requests).
  if (saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    try {
      localStorage.setItem(KEY, JSON.stringify(pending));
    } catch {
      // Not kept.
    }
    window.dispatchEvent(new Event(TRANSFER_EVENT));
  }, 1000);
}

export function logTransfer(t: { via: Via; up?: number; down?: number; what: string }) {
  const up = t.up ?? 0;
  const down = t.down ?? 0;
  if (!up && !down) return;
  const list = pending ?? transfers();
  const now = Date.now();
  const last = list[0];
  if (t.via === "wifi" && last && last.via === "wifi" && now - last.at < 60_000 && last.what === t.what) {
    list[0] = { ...last, up: last.up + up, down: last.down + down, n: last.n + 1, at: now };
  } else list.unshift({ at: now, via: t.via, up, down, what: t.what, n: 1 });
  save(list.slice(0, MAX));
}

export const clearTransfers = () => save([]);

export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
