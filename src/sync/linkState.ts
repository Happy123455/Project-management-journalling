import { logAnomaly } from "./anomalies";

/**
 * The Wi-Fi link to the other device, in words (14 Nov: the menu said "Live with your other
 * device" while Send couldn't reach the Mac). "Live" there only meant the other app was open,
 * seen through a small file on Google Drive; it said nothing about the Wi-Fi link that Send and
 * live typing use. Now the link has its own state, set only by real requests that got an answer
 * (the phone's hello and pulls, the Mac hearing from the phone), and every change goes to the
 * sync log with its reason.
 */
export type LinkPhase = "up" | "trying" | "down" | "off";
export interface LinkState {
  state: LinkPhase;
  /** Why it isn't up, in words. */
  reason?: string;
  /** Since when (ms). */
  at: number;
  /** The other device's Wi-Fi address, when known. */
  ip?: string;
  /** A hello's round trip, ms (when up). */
  rttMs?: number;
}

export const LINK_EVENT = "journal:link";
let current: LinkState = { state: "off", at: Date.now() };
export const linkState = () => current;

/** A new link state: logged and announced only when the state or the reason changed. */
export function setLink(next: Omit<LinkState, "at">) {
  if (next.state === current.state && next.reason === current.reason && next.ip === current.ip) return;
  const was = current;
  current = { ...next, at: Date.now() };
  // "trying" comes and goes with every retry: only what it came to is worth a line in the log.
  if (next.state !== "trying")
    logAnomaly({
      kind: "link",
      path: "wifi",
      text: next.state === "up" ? `Wi-Fi link up${next.ip ? ` (${next.ip})` : ""}${next.rttMs !== undefined ? `, answered in ${next.rttMs} ms` : ""}` : `Wi-Fi link ${next.state}: ${next.reason ?? "?"}`,
      detail: { ip: next.ip, rttMs: next.rttMs, was: was.state, wasFor: Date.now() - was.at },
    });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LINK_EVENT));
}

/** Why a request to the other device failed, in words. */
export function linkReason(e: unknown, other: string, ip?: string): string {
  const s = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/HTTP 40[13]|bad key|forbidden/i.test(s)) return `your ${other} didn't accept this device's key: open the journal on both with Drive sync on for a minute, then ⚡ Connect`;
  if (/abort|timed? ?out|timeout/i.test(s)) return `your ${other} didn't answer in time${ip ? ` at ${ip}` : ""} (asleep, or the journal is busy)`;
  if (/HTTP 5\d\d/.test(s)) return `your ${other}'s journal answered with an error (${s.match(/HTTP \d+/)?.[0]})`;
  return `can't reach your ${other}${ip ? ` at ${ip}` : ""} on this Wi-Fi: is the journal open on it, and are both on the same Wi-Fi?`;
}
