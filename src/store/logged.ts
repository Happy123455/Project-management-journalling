/** Fired on window whenever this device writes an event, so the Wi-Fi link sends it at once
 * (instead of checking the database every second, which kept the phone busy). */
export const EVENT_LOGGED = "journal:event-logged";

export function notifyLogged() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  queueMicrotask(() => window.dispatchEvent(new Event(EVENT_LOGGED)));
}
