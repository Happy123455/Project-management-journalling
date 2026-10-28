export const newId = () => crypto.randomUUID();

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
