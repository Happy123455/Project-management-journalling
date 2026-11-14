import type { SyncFolder } from "./engine";
import type { DirectAddress } from "./direct";

/**
 * Live mode: while the app is open on two devices, each one keeps a tiny presence file in the
 * sync folder (presence/<device>.json). A device that sees another one open checks every couple
 * of seconds whether that device wrote something new, and sends its own edits right after they're
 * saved. When the other app closes (or goes quiet), it goes back to the normal rhythm.
 */
export interface Presence {
  /** When this was written (ms since 1970). */
  at: number;
  /** Changes whenever the device sent new edits; another device syncs when it sees a new value. */
  rev: string;
  /** Written as the app goes to the background or closes. */
  closed?: boolean;
  /** Mac: where the phone can reach it on the Wi-Fi for instant sync (see direct.ts). */
  lan?: DirectAddress;
}

/** How often an open app says it's still open (the Mac: on mains power). */
export const BEAT_MS = 10_000;
/** The phone says it less often: each beat is two Drive requests (battery, 8 Nov). */
export const PHONE_BEAT_MS = 20_000;
/** Another device counts as open while its presence is this fresh (Drive for desktop adds delay). */
export const FRESH_MS = 60_000;
/** How often to look for the other device's changes while both are open and edits are flowing. */
export const LIVE_POLL_MS = 2_000;
/** Both open but nothing changed for a while (e.g. the Mac is open in another room): look this often. */
export const CALM_POLL_MS = 10_000;
/** Edits flowing = a change seen or saved within this long; then polling is LIVE_POLL_MS. */
export const HOT_MS = 60_000;
/** How soon after a save edits go out while both are open (a pause in typing, not every word). */
export const LIVE_SAVE_MS = 3_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function writePresence(folder: SyncFolder, me: string, p: Presence) {
  await folder.write(`presence/${me}.json`, enc.encode(JSON.stringify(p)));
}

/** Other devices' presence that changed since `known` (by file stamp), read only when it changed. */
export async function readPresence(folder: SyncFolder, me: string, known: Map<string, { stamp: string; p: Presence | null }>) {
  const names = (await folder.list("presence")).filter((n) => n.endsWith(".json") && n !== `${me}.json`);
  for (const name of names) {
    const path = `presence/${name}`;
    const stamp = (await folder.stamp?.(path)) ?? String(Date.now());
    const prev = known.get(name);
    if (prev && prev.stamp === stamp) continue;
    let p: Presence | null = null;
    try {
      const bytes = await folder.read(path);
      p = bytes ? (JSON.parse(dec.decode(bytes)) as Presence) : null;
    } catch {
      p = null;
    }
    known.set(name, { stamp, p });
  }
  return known;
}

/** True when some other device's app is open right now. */
export function someoneOpen(known: Map<string, { p: Presence | null }>, now = Date.now()) {
  for (const { p } of known.values()) if (p && !p.closed && now - p.at < FRESH_MS) return true;
  return false;
}

/** A value that changes whenever any other device's rev does. */
export const othersRev = (known: Map<string, { p: Presence | null }>) =>
  [...known.entries()].map(([k, v]) => `${k}:${v.p?.rev ?? ""}`).sort().join("|");

/** The address of another device's open app that takes direct connections, if any. */
export function openHost(known: Map<string, { p: Presence | null }>, now = Date.now()) {
  for (const { p } of known.values()) if (p?.lan && !p.closed && now - p.at < FRESH_MS) return p.lan;
  return null;
}
