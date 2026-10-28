export const newId = () => crypto.randomUUID();

/**
 * Day and named pages get ids every device can work out on its own, so pages two devices
 * create for the same day (or name) are the same page once they sync.
 */
export const dayBlockId = (day: string) => `day:${day}`;
export const pageBlockId = (title: string) => `page:${title.trim().toLowerCase()}`;

const DEVICE_KEY = "dynamic-journal.device-id";

/** Stable id for this install, stored once. */
export function deviceId(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): string {
  try {
    const existing = storage?.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = newId();
    storage?.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return "unknown-device";
  }
}
